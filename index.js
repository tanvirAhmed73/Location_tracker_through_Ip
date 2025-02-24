const http = require('http');
const websocket = require('ws');
const axios = require('axios');

// Configuration
const CONFIG = {
    PORT: 3000,
    API_ENDPOINTS: {
        IP_INFO: 'http://ip-api.com/json', // Changed to more reliable API
        PUBLIC_IP: 'https://api.ipify.org?format=json'
    },
    RATE_LIMIT_MS: 1000
};

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end("IP Location Tracker Server Running");
});

const wss = new websocket.WebSocketServer({ server });
const clients = new Map();

// In the getIPLocation function
async function getIPLocation(ip) {
    try {
        const axiosConfig = {
            timeout: 10000,
            headers: {
                'User-Agent': 'IP-Tracker/1.0'
            }
        };

        // Get public IP if not provided or if local IP
        if (!ip || ip === '127.0.0.1' || ip === 'localhost' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
            const { data } = await axios.get(CONFIG.API_ENDPOINTS.PUBLIC_IP, axiosConfig);
            ip = data.ip;
        }

        await new Promise(resolve => setTimeout(resolve, CONFIG.RATE_LIMIT_MS));
        
        const { data } = await axios.get(`${CONFIG.API_ENDPOINTS.IP_INFO}/${ip}`, axiosConfig);
        
        if (data.status === 'fail') {
            throw new Error(data.message || 'API Error');
        }

        return {
            lat: parseFloat(data.lat),
            lng: parseFloat(data.lon),
            city: data.city || 'Unknown City',
            country: data.country || 'Unknown Country',
            ip: ip,
            region: data.regionName || 'Unknown Region',
            isp: data.isp || 'Unknown ISP',
            timezone: data.timezone || 'Unknown Timezone'
        };
    } catch (error) {
        console.error(`IP Location Error (${ip}):`, error.message);
        throw new Error(`Could not locate IP: ${error.message}`);
    }
}

wss.on('connection', (ws, req) => {
    const clientId = Date.now().toString();
    const clientIp = req.socket.remoteAddress?.replace('::ffff:', '') || '';
    
    clients.set(clientId, { ws, lastQuery: Date.now() });
    console.log(`Client connected: ${clientId} from ${clientIp}`);
    
    ws.send(JSON.stringify({ type: 'id', clientId }));

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === 'ip-lookup') {
                const client = clients.get(clientId);
                const now = Date.now();
                
                // Rate limiting per client
                if (now - client.lastQuery < CONFIG.RATE_LIMIT_MS) {
                    throw new Error('Too many requests');
                }
                
                client.lastQuery = now;
                const location = await getIPLocation(data.ip);
                
                ws.send(JSON.stringify({
                    type: 'ip-location',
                    location: location || { error: 'Could not locate IP' }
                }));
            }
        } catch (error) {
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
    console.log(`IP Location Tracker running on port ${CONFIG.PORT}`);
}).on('error', (error) => {
    console.error('Server error:', error.message);
});