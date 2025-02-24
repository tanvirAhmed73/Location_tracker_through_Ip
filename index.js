const http = require('http');
const websocket = require('ws');
const axios = require('axios');
const express = require('express');
const session = require('express-session');
const nodemailer = require('nodemailer');
const CONFIG = {
    PORT: 3000,
    API_ENDPOINTS: {
        IP_INFO: 'http://ip-api.com/json',
        PUBLIC_IP: 'https://api.ipify.org?format=json',
        PHONE_INFO: 'https://api.apilayer.com/number_verification/validate'
    },
    API_KEY: 'VhADRxa240Fr4mUehSj9Orf44VjzaQci',
    EMAIL: {
        service: 'gmail',
        user: 'tanvirbdcallingnode.js@gmail.com',
        pass: 'gnnb hrpy mjvy ybbn'  // You'll replace this with the App Password
    },
    RATE_LIMIT_MS: 2000
};

// Initialize email transporter
const emailTransporter = nodemailer.createTransport({
    service: CONFIG.EMAIL.service,
    auth: {
        user: CONFIG.EMAIL.user,
        pass: CONFIG.EMAIL.pass
    }
});

// Create Express app
const app = express();
app.use(express.json());
app.use(session({
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: true
}));

// Store pending requests
const pendingRequests = new Map();
const clients = new Map();

async function getIPLocation(ip) {
    try {
        if (!ip || ip === '127.0.0.1' || ip === 'localhost') {
            const { data } = await axios.get(CONFIG.API_ENDPOINTS.PUBLIC_IP);
            ip = data.ip;
        }

        const { data } = await axios.get(`${CONFIG.API_ENDPOINTS.IP_INFO}/${ip}`);
        
        if (data.status === 'fail') {
            throw new Error(data.message || 'API Error');
        }

        return {
            lat: data.lat,
            lng: data.lon,
            city: data.city || 'Unknown City',
            country: data.country || 'Unknown Country',
            ip: ip,
            region: data.regionName || 'Unknown Region',
            isp: data.isp || 'Unknown ISP',
            timezone: data.timezone || 'Unknown Timezone'
        };
    } catch (error) {
        console.error(`IP Location Error (${ip}):`, error);
        throw new Error(`Could not locate IP: ${error.message}`);
    }
 }

async function getPhoneLocation(phoneNumber, requesterId, email) {  // Add email parameter
    try {
        const response = await axios.get(CONFIG.API_ENDPOINTS.PHONE_INFO, {
            headers: { 'apikey': CONFIG.API_KEY },
            params: { number: phoneNumber }
        });

        if (!response.data?.valid) {
            throw new Error('Invalid phone number');
        }

        const verificationCode = Math.floor(100000 + Math.random() * 900000);
        const requestId = Date.now().toString();

        pendingRequests.set(requestId, {
            phoneNumber,
            requesterId,
            verificationCode,
            timestamp: Date.now()
        });

        const verificationLink = `http://localhost:3000/verify/${requestId}`;
        
        // Fixed email sending
        await emailTransporter.sendMail({
            from: CONFIG.EMAIL.user,
            to: email,  // Use the email parameter
            subject: 'Location Sharing Request',
            html: `
                <h2>Location Sharing Request</h2>
                <p>Someone requested your location for phone number: ${phoneNumber}</p>
                <p>Click <a href="${verificationLink}">here</a> to share your location.</p>
                <p>Verification code: ${verificationCode}</p>
            `
        });

        return {
            requestId,
            status: 'pending',
            message: 'Location request sent. Waiting for response...',
            carrier: response.data.carrier,
            country: response.data.country_name
        };
    } catch (error) {
        console.error('Phone Location Error:', error);
        throw new Error(`Location request failed: ${error.message}`);
    }
}

// Add verification endpoint
app.get('/verify/:requestId', async (req, res) => {
    const { requestId } = req.params;
    const request = pendingRequests.get(requestId);

    if (!request) {
        return res.send('Invalid or expired request');
    }

    // Serve verification page
    res.send(`
        <html>
            <body>
                <h1>Location Sharing Request</h1>
                <p>Verification code: ${request.verificationCode}</p>
                <button onclick="shareLocation()">Share My Location</button>
                <button onclick="denyRequest()">Deny Request</button>
                <script>
                    function shareLocation() {
                        if ("geolocation" in navigator) {
                            navigator.geolocation.getCurrentPosition(
                                position => sendResponse(position, true),
                                () => alert('Could not get location')
                            );
                        }
                    }

                    function denyRequest() {
                        sendResponse(null, false);
                    }

                    function sendResponse(position, accepted) {
                        fetch('/verify-response', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                requestId: '${requestId}',
                                accepted,
                                location: accepted ? {
                                    lat: position.coords.latitude,
                                    lng: position.coords.longitude,
                                    accuracy: position.coords.accuracy
                                } : null
                            })
                        });
                    }
                </script>
            </body>
        </html>
    `);
});

// Handle verification response
app.post('/verify-response', (req, res) => {
    const { requestId, accepted, location } = req.body;
    const request = pendingRequests.get(requestId);

    if (!request) {
        return res.status(400).json({ error: 'Invalid request' });
    }

    const requester = Array.from(clients.values())
        .find(c => c.id === request.requesterId);

    if (requester) {
        requester.ws.send(JSON.stringify({
            type: 'location-response',
            accepted,
            location: accepted ? {
                ...location,
                phoneNumber: request.phoneNumber,
                timestamp: Date.now()
            } : null,
            message: accepted ? 'Location shared' : 'Request denied'
        }));
    }

    pendingRequests.delete(requestId);
    res.json({ success: true });
});

// Create server
const server = http.createServer(app);
const wss = new websocket.WebSocketServer({ server });

// WebSocket connection handling
wss.on('connection', (ws, req) => {
    const clientId = Date.now().toString();
    const clientIp = req.socket.remoteAddress?.replace('::ffff:', '') || '';
    
    clients.set(clientId, { 
        ws,
        id: clientId,
        lastQuery: 0,
        pendingRequest: false
    });
    
    console.log(`Client connected: ${clientId} from ${clientIp}`);
    
    ws.send(JSON.stringify({ type: 'id', clientId }));

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            const client = clients.get(clientId);

            if (client.pendingRequest) {
                throw new Error('Please wait for the current request to complete');
            }

            const now = Date.now();
            const timeSinceLastQuery = now - client.lastQuery;
            
            if (timeSinceLastQuery < CONFIG.RATE_LIMIT_MS) {
                const waitTime = Math.ceil((CONFIG.RATE_LIMIT_MS - timeSinceLastQuery) / 1000);
                throw new Error(`Please wait ${waitTime} seconds before trying again`);
            }
            
            client.pendingRequest = true;
            client.lastQuery = now;
            let location;
// In the WebSocket message handler
if (data.type === 'ip-lookup') {
    location = await getIPLocation(data.ip);
} else if (data.type === 'phone-lookup') {
    location = await getPhoneLocation(data.phoneNumber, clientId, data.email);  // Pass email
}
            client.pendingRequest = false;
            ws.send(JSON.stringify({
                type: 'location-result',
                location: location
            }));
        } catch (error) {
            const client = clients.get(clientId);
            if (client) {
                client.pendingRequest = false;
            }
            console.error('Error processing request:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: error.message
            }));
        }
    });

    ws.on('close', () => {
        clients.delete(clientId);
        console.log(`Client disconnected: ${clientId}`);
    });

    ws.on('error', (error) => {
        console.error(`Client error (${clientId}):`, error.message);
        clients.delete(clientId);
    });
});

server.listen(CONFIG.PORT, () => {
    console.log(`Server running on port ${CONFIG.PORT}`);
}).on('error', (error) => {
    console.error('Server error:', error.message);
});
