# Ship Proxy System

A two-tier proxy system consisting of an offshore proxy and a ship proxy that work together to handle HTTP/HTTPS requests through a custom protocol.

## Architecture

- **Offshore Proxy** (`offshore_proxy.js`): Handles the actual HTTP/HTTPS requests and communicates with target servers
- **Ship Proxy** (`ship_proxy.js`): Acts as a client-facing proxy that forwards requests to the offshore proxy using a custom framing protocol

## Prerequisites

- Node.js (LTS version recommended)
- Docker (optional, for containerized deployment)

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd segments
```

2. Install dependencies:
```bash
npm install
```

## Environment Variables

Create a `.env` file in the project root with the following variables:

```env
OFFSHORE_PORT=9999
SHIP_PROXY_PORT=8080
OFFSHORE_HOST=<host IPv4 Address>
```

## Running the Proxies

### Quick Start (Windows)

If ports 9999 and 8080 are available, you can simply:
1. Navigate to the cloned project folder
2. Double-click `start-proxy.bat` file

This will automatically start both proxies in separate command windows.

### Method 1: Manual Terminal Setup

1. **Start the Offshore Proxy** (Terminal 1):
```bash
node offshore_proxy.js
```
The offshore proxy will start listening on port 9999.

2. **Start the Ship Proxy** (Terminal 2):
```bash
node ship_proxy.js
```
The ship proxy will start listening on port 8080 and connect to the offshore proxy.


## Docker Deployment

### Building Docker Images

Build the offshore proxy image:
```bash
docker build -f Dockerfile.offshore -t segments-offshore .
```

Build the ship proxy image:
```bash
docker build -f Dockerfile.ship -t segments-ship .
```

### Running with Docker

Docker Run Commands

1. **Start the Offshore Proxy Container**:
```bash
docker run -d --name offshore-proxy -p 9999:9999 segments-offshore
```

2. **Start the Ship Proxy Container**:
```bash
docker run -d --name ship-proxy -p 8080:8080 -e OFFSHORE_HOST=host.docker.internal -e OFFSHORE_PORT=9999 segments-ship
```

## Testing the Proxy

Once both proxies are running, you can test them using curl commands:

### HTTP Requests

**For Linux/macOS:**
```bash
curl -x http://localhost:8080 http://httpforever.com/
curl -x http://localhost:8080 https://example.com/
```

**For Windows:**
```bash
curl.exe -x http://localhost:8080 http://httpforever.com/
curl.exe -x http://localhost:8080 https://example.com/
```

### Additional Test Commands

Test with different endpoints:
```bash
# Test HTTP
curl.exe -x http://localhost:8080 http://httpbin.org/get

# Test HTTPS
curl.exe -x http://localhost:8080 https://httpbin.org/get

# Test with headers
curl.exe -x http://localhost:8080 -H "User-Agent: TestAgent" https://httpbin.org/headers
```

## Configuration

### Port Configuration

- **Offshore Proxy**: Default port 9999 (configurable via `OFFSHORE_PORT`)
- **Ship Proxy**: Default port 8080 (configurable via `SHIP_PROXY_PORT`)

### Network Configuration

The ship proxy connects to the offshore proxy using the `OFFSHORE_HOST` and `OFFSHORE_PORT` environment variables.

## Troubleshooting

### Common Issues

1. **Connection Refused**: Ensure both proxies are running and the offshore proxy is accessible from the ship proxy
2. **Port Already in Use**: Check if ports 8080 or 9999 are already in use and change the configuration accordingly
3. **Docker Network Issues**: When using Docker, ensure proper network configuration between containers

### Logs

Both proxies output connection and error information to the console. Check the terminal output for debugging information.

## Development

### Project Structure

```
segments/
├── offshore_proxy.js      # Offshore proxy server
├── ship_proxy.js          # Ship proxy server  
├── protocol.js            # Custom protocol implementation
├── package.json           # Node.js dependencies
├── Dockerfile.offshore    # Docker config for offshore proxy
├── Dockerfile.ship        # Docker config for ship proxy
├── start-proxy.bat        # Windows batch script
└── README.md              # This file
```

### Protocol

The proxies communicate using a custom framing protocol defined in `protocol.js`. This allows for reliable message transmission between the ship and offshore proxies.

