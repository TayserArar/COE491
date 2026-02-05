/**
 * DANS ILS File Watcher Server
 * 
 * Real-time file watching using chokidar with WebSocket notifications
 * 
 * Usage:
 *   node server.js                     # Start with default watch folder
 *   node server.js /path/to/folder     # Start with custom watch folder
 *   node server.js --port 3001         # Start on custom port
 * 
 * The server will:
 *   1. Watch the specified folder for .log, .txt, .csv files
 *   2. Watch for processed_data.json updates from Python processor
 *   3. Notify connected clients via WebSocket when files change
 *   4. Serve the dashboard files via HTTP
 *   5. Provide REST API for file operations
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    port: parseInt(process.argv.find(arg => arg.startsWith('--port='))?.split('=')[1]) || 3000,
    watchFolder: process.argv[2] && !process.argv[2].startsWith('--') 
        ? path.resolve(process.argv[2]) 
        : path.join(__dirname, 'watch-folder'),
    validExtensions: ['.log', '.txt', '.csv'],
    debounceMs: 300,
    processedDataFile: path.join(__dirname, 'processed_data.json')
};

// ============================================
// EXPRESS SERVER SETUP
// ============================================
const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // Serve dashboard files

// Serve dashboard.html at root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ============================================
// WEBSOCKET SERVER SETUP
// ============================================
const wss = new WebSocket.Server({ server });
const clients = new Set();

wss.on('connection', (ws) => {
    console.log('[WebSocket] Client connected');
    clients.add(ws);
    
    // Send current file list on connection
    ws.send(JSON.stringify({
        type: 'connected',
        message: 'Connected to file watcher',
        watchFolder: CONFIG.watchFolder,
        files: getWatchedFiles()
    }));
    
    // Send current processed data if available
    sendProcessedData(ws);
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleClientMessage(ws, data);
        } catch (err) {
            console.error('[WebSocket] Error parsing message:', err);
        }
    });
    
    ws.on('close', () => {
        console.log('[WebSocket] Client disconnected');
        clients.delete(ws);
    });
    
    ws.on('error', (err) => {
        console.error('[WebSocket] Error:', err);
        clients.delete(ws);
    });
});

/**
 * Broadcast message to all connected clients
 */
function broadcast(data) {
    const message = JSON.stringify(data);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

/**
 * Send processed data to a specific client
 */
function sendProcessedData(ws) {
    try {
        if (fs.existsSync(CONFIG.processedDataFile)) {
            const data = fs.readFileSync(CONFIG.processedDataFile, 'utf-8');
            const parsed = JSON.parse(data);
            
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'processed-data',
                    data: parsed
                }));
            }
        }
    } catch (err) {
        console.error('[WebSocket] Error sending processed data:', err);
    }
}

/**
 * Broadcast processed data to all clients
 */
function broadcastProcessedData() {
    try {
        if (fs.existsSync(CONFIG.processedDataFile)) {
            const data = fs.readFileSync(CONFIG.processedDataFile, 'utf-8');
            const parsed = JSON.parse(data);
            
            broadcast({
                type: 'processed-data-updated',
                data: parsed
            });
            
            console.log(`[Watcher] Broadcast processed data: ${parsed.metadata?.total_records || 0} records`);
        }
    } catch (err) {
        console.error('[Watcher] Error broadcasting processed data:', err);
    }
}

/**
 * Handle messages from clients
 */
function handleClientMessage(ws, data) {
    switch (data.type) {
        case 'get-files':
            ws.send(JSON.stringify({
                type: 'file-list',
                files: getWatchedFiles()
            }));
            break;
            
        case 'get-file-content':
            getFileContent(data.filename).then(content => {
                ws.send(JSON.stringify({
                    type: 'file-content',
                    filename: data.filename,
                    content: content
                }));
            }).catch(err => {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: err.message
                }));
            });
            break;
            
        case 'get-processed-data':
            sendProcessedData(ws);
            break;
            
        case 'rescan':
            ws.send(JSON.stringify({
                type: 'file-list',
                files: getWatchedFiles()
            }));
            break;
            
        default:
            console.log('[WebSocket] Unknown message type:', data.type);
    }
}

// ============================================
// FILE WATCHER (CHOKIDAR)
// ============================================
let watcher = null;
let processedDataWatcher = null;
const watchedFiles = new Map(); // filename -> file info

/**
 * Initialize chokidar file watcher for log files
 */
function initializeWatcher() {
    // Create watch folder if it doesn't exist
    if (!fs.existsSync(CONFIG.watchFolder)) {
        fs.mkdirSync(CONFIG.watchFolder, { recursive: true });
        console.log(`[Watcher] Created watch folder: ${CONFIG.watchFolder}`);
    }
    
    // Build glob pattern for valid extensions
    const globPattern = path.join(CONFIG.watchFolder, '**/*');
    
    console.log(`[Watcher] Starting to watch: ${CONFIG.watchFolder}`);
    console.log(`[Watcher] Valid extensions: ${CONFIG.validExtensions.join(', ')}`);
    
    watcher = chokidar.watch(globPattern, {
        ignored: /(^|[\/\\])\../, // Ignore dotfiles
        persistent: true,
        ignoreInitial: false,
        awaitWriteFinish: {
            stabilityThreshold: CONFIG.debounceMs,
            pollInterval: 100
        },
        depth: 2 // Watch up to 2 levels deep
    });
    
    // File added
    watcher.on('add', (filePath) => {
        if (isValidFile(filePath)) {
            const fileInfo = getFileInfo(filePath);
            watchedFiles.set(fileInfo.filename, fileInfo);
            console.log(`[Watcher] File added: ${fileInfo.filename}`);
            
            broadcast({
                type: 'file-added',
                file: fileInfo,
                allFiles: getWatchedFiles()
            });
        }
    });
    
    // File changed
    watcher.on('change', (filePath) => {
        if (isValidFile(filePath)) {
            const fileInfo = getFileInfo(filePath);
            watchedFiles.set(fileInfo.filename, fileInfo);
            console.log(`[Watcher] File changed: ${fileInfo.filename}`);
            
            broadcast({
                type: 'file-changed',
                file: fileInfo,
                allFiles: getWatchedFiles()
            });
        }
    });
    
    // File deleted
    watcher.on('unlink', (filePath) => {
        const filename = path.basename(filePath);
        if (watchedFiles.has(filename)) {
            watchedFiles.delete(filename);
            console.log(`[Watcher] File removed: ${filename}`);
            
            broadcast({
                type: 'file-removed',
                filename: filename,
                allFiles: getWatchedFiles()
            });
        }
    });
    
    // Watcher ready
    watcher.on('ready', () => {
        console.log(`[Watcher] Initial scan complete. Found ${watchedFiles.size} files.`);
        broadcast({
            type: 'watcher-ready',
            files: getWatchedFiles()
        });
    });
    
    // Watcher error
    watcher.on('error', (err) => {
        console.error('[Watcher] Error:', err);
        broadcast({
            type: 'watcher-error',
            message: err.message
        });
    });
}

/**
 * Initialize watcher for processed_data.json
 */
function initializeProcessedDataWatcher() {
    console.log(`[Watcher] Watching for processed data: ${CONFIG.processedDataFile}`);
    
    // Watch the directory containing the processed data file
    const watchDir = path.dirname(CONFIG.processedDataFile);
    const watchFilename = path.basename(CONFIG.processedDataFile);
    
    processedDataWatcher = chokidar.watch(CONFIG.processedDataFile, {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: {
            stabilityThreshold: 500,
            pollInterval: 100
        }
    });
    
    processedDataWatcher.on('add', () => {
        console.log('[Watcher] Processed data file created');
        broadcastProcessedData();
    });
    
    processedDataWatcher.on('change', () => {
        console.log('[Watcher] Processed data file updated');
        broadcastProcessedData();
    });
    
    processedDataWatcher.on('error', (err) => {
        console.error('[Watcher] Processed data watcher error:', err);
    });
}

/**
 * Check if file has valid extension
 */
function isValidFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return CONFIG.validExtensions.includes(ext);
}

/**
 * Get file info object
 */
function getFileInfo(filePath) {
    const stats = fs.statSync(filePath);
    const filename = path.basename(filePath);
    const fileInfo = detectFilePeriod(filename);
    const equipmentType = detectEquipmentType(filePath);
    
    return {
        filename: filename,
        path: filePath,
        relativePath: path.relative(CONFIG.watchFolder, filePath),
        size: stats.size,
        sizeFormatted: formatFileSize(stats.size),
        lastModified: stats.mtime.toISOString(),
        lastModifiedFormatted: stats.mtime.toLocaleString(),
        ...fileInfo,
        ...equipmentType
    };
}

/**
 * Detect equipment type (GP or LLZ) from file content
 * LLZ files contain 'CL ID MOD (%)' in the header
 * GP files do not contain this column
 */
function detectEquipmentType(filePath) {
    try {
        // Read first 5KB of file to check header
        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(5000);
        fs.readSync(fd, buffer, 0, 5000, 0);
        fs.closeSync(fd);
        
        const headerContent = buffer.toString('utf-8');
        
        if (headerContent.includes('CL ID MOD (%)')) {
            return {
                equipmentType: 'llz',
                equipmentLabel: 'Localizer (LLZ)',
                equipmentShort: 'LLZ'
            };
        } else {
            return {
                equipmentType: 'gp',
                equipmentLabel: 'Glide Path (GP)',
                equipmentShort: 'GP'
            };
        }
    } catch (err) {
        console.warn(`[Watcher] Could not detect equipment type for ${filePath}:`, err.message);
        return {
            equipmentType: 'unknown',
            equipmentLabel: 'Unknown',
            equipmentShort: '?'
        };
    }
}

/**
 * Detect file period (morning/afternoon) from filename
 * Pattern: ContMon_YYYY-MM-DD-a.log (morning) or ContMon_YYYY-MM-DD-b.log (afternoon)
 */
function detectFilePeriod(filename) {
    const match = filename.match(/(\d{4}-\d{2}-\d{2})-([ab])/i);
    if (match) {
        return {
            dateStr: match[1],
            period: match[2].toLowerCase() === 'a' ? 'morning' : 'afternoon',
            periodLabel: match[2].toLowerCase() === 'a' ? 'Morning (a)' : 'Afternoon (b)'
        };
    }
    
    // Try to extract just the date
    const dateMatch = filename.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
        return {
            dateStr: dateMatch[1],
            period: 'unknown',
            periodLabel: 'Unknown Period'
        };
    }
    
    // Default to today
    const today = new Date().toISOString().split('T')[0];
    return {
        dateStr: today,
        period: 'unknown',
        periodLabel: 'Unknown Period'
    };
}

/**
 * Get all watched files as array
 */
function getWatchedFiles() {
    const files = Array.from(watchedFiles.values());
    // Sort by date (newest first) then by period
    files.sort((a, b) => {
        if (a.dateStr !== b.dateStr) {
            return b.dateStr.localeCompare(a.dateStr);
        }
        return a.period.localeCompare(b.period);
    });
    return files;
}

/**
 * Get file content
 */
async function getFileContent(filename) {
    const fileInfo = watchedFiles.get(filename);
    if (!fileInfo) {
        throw new Error(`File not found: ${filename}`);
    }
    return fs.promises.readFile(fileInfo.path, 'utf-8');
}

/**
 * Format file size
 */
function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ============================================
// REST API ENDPOINTS
// ============================================

// Get server status
app.get('/api/status', (req, res) => {
    res.json({
        status: 'running',
        watchFolder: CONFIG.watchFolder,
        fileCount: watchedFiles.size,
        connectedClients: clients.size,
        uptime: process.uptime()
    });
});

// Get all watched files
app.get('/api/files', (req, res) => {
    res.json({
        watchFolder: CONFIG.watchFolder,
        files: getWatchedFiles()
    });
});

// Get specific file info
app.get('/api/files/:filename', (req, res) => {
    const fileInfo = watchedFiles.get(req.params.filename);
    if (fileInfo) {
        res.json(fileInfo);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// Get file content
app.get('/api/files/:filename/content', async (req, res) => {
    try {
        const content = await getFileContent(req.params.filename);
        res.type('text/plain').send(content);
    } catch (err) {
        res.status(404).json({ error: err.message });
    }
});

// Get processed data
app.get('/api/processed-data', (req, res) => {
    try {
        if (fs.existsSync(CONFIG.processedDataFile)) {
            const data = fs.readFileSync(CONFIG.processedDataFile, 'utf-8');
            res.json(JSON.parse(data));
        } else {
            res.json({ 
                metadata: { total_records: 0, columns: [] }, 
                files: [], 
                records: [] 
            });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Change watch folder
app.post('/api/watch-folder', (req, res) => {
    const { folder } = req.body;
    if (!folder) {
        return res.status(400).json({ error: 'Folder path required' });
    }
    
    const newFolder = path.resolve(folder);
    if (!fs.existsSync(newFolder)) {
        return res.status(400).json({ error: 'Folder does not exist' });
    }
    
    // Stop current watcher
    if (watcher) {
        watcher.close();
    }
    
    // Update config and restart watcher
    CONFIG.watchFolder = newFolder;
    watchedFiles.clear();
    initializeWatcher();
    
    res.json({
        success: true,
        watchFolder: CONFIG.watchFolder
    });
});

// Trigger manual rescan
app.post('/api/rescan', (req, res) => {
    watchedFiles.clear();
    if (watcher) {
        watcher.close();
    }
    initializeWatcher();
    res.json({ success: true, message: 'Rescan initiated' });
});

// ============================================
// SERVER STARTUP
// ============================================
server.listen(CONFIG.port, () => {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║       DANS ILS File Watcher Server                         ║');
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log(`║  HTTP Server:    http://localhost:${CONFIG.port}                    ║`);
    console.log(`║  WebSocket:      ws://localhost:${CONFIG.port}                      ║`);
    console.log(`║  Watch Folder:   ${CONFIG.watchFolder.substring(0, 40).padEnd(40)} ║`);
    console.log('╠════════════════════════════════════════════════════════════╣');
    console.log('║  Endpoints:                                                ║');
    console.log('║    GET  /api/status          - Server status               ║');
    console.log('║    GET  /api/files           - List all files              ║');
    console.log('║    GET  /api/files/:name     - Get file info               ║');
    console.log('║    GET  /api/files/:name/content - Get file content        ║');
    console.log('║    GET  /api/processed-data  - Get processed JSON data     ║');
    console.log('║    POST /api/watch-folder    - Change watch folder         ║');
    console.log('║    POST /api/rescan          - Trigger rescan              ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log('');
    
    // Initialize file watchers
    initializeWatcher();
    initializeProcessedDataWatcher();
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n[Server] Shutting down...');
    if (watcher) {
        watcher.close();
    }
    if (processedDataWatcher) {
        processedDataWatcher.close();
    }
    wss.close();
    server.close(() => {
        console.log('[Server] Goodbye!');
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    process.emit('SIGINT');
});
