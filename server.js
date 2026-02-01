require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const validator = require('validator');
const sanitize = require('sanitize-filename');
const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, 'temp');
const MAX_FILE_AGE_MS = 30 * 60 * 1000; // 30 minutes

// Cobalt API endpoint
const COBALT_API = 'https://api.cobalt.tools/api/json';

// ============================================
// SECURITY MIDDLEWARE
// ============================================

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
    }
  }
}));

app.use(express.json({ limit: '1kb' }));
app.use(express.urlencoded({ extended: true, limit: '1kb' }));

// Rate limiting: 20 requests per hour per IP
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Too many requests. Please wait before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/convert', limiter);

// ============================================
// UTILITY FUNCTIONS
// ============================================

function isValidYouTubeUrl(url) {
  if (!validator.isURL(url, {
    protocols: ['http', 'https'],
    require_protocol: true
  })) {
    return false;
  }

  const allowedDomains = [
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'youtu.be'
  ];

  try {
    const urlObj = new URL(url);
    return allowedDomains.includes(urlObj.hostname);
  } catch {
    return false;
  }
}

async function ensureTempDir() {
  try {
    await fs.access(TEMP_DIR);
  } catch {
    await fs.mkdir(TEMP_DIR, { recursive: true });
  }
}

async function cleanupOldFiles() {
  try {
    const files = await fs.readdir(TEMP_DIR);
    const now = Date.now();

    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      try {
        const stats = await fs.stat(filePath);

        if (now - stats.mtimeMs > MAX_FILE_AGE_MS) {
          await fs.unlink(filePath);
          console.log(`Cleaned up old file: ${file}`);
        }
      } catch (err) {
        continue;
      }
    }
  } catch (error) {
    console.error('Cleanup error:', error.message);
  }
}

// Function to call Cobalt API
async function getCobaltDownloadUrl(youtubeUrl) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      url: youtubeUrl,
      vCodec: "h264",
      vQuality: "720",
      aFormat: "mp3",
      filenamePattern: "basic",
      isAudioOnly: true,
      disableMetadata: false
    });

    const options = {
      hostname: 'api.cobalt.tools',
      port: 443,
      path: '/api/json',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          console.log('Cobalt response:', result);

          if (result.status === 'error') {
            reject(new Error(result.text || 'Cobalt API error'));
          } else if (result.status === 'redirect' || result.status === 'stream') {
            resolve({
              url: result.url,
              filename: result.filename || 'audio.mp3'
            });
          } else if (result.url) {
            resolve({
              url: result.url,
              filename: result.filename || 'audio.mp3'
            });
          } else {
            reject(new Error('Unexpected response from Cobalt API'));
          }
        } catch (e) {
          reject(new Error('Failed to parse Cobalt response'));
        }
      });
    });

    req.on('error', (e) => {
      reject(new Error(`Cobalt API request failed: ${e.message}`));
    });

    req.write(postData);
    req.end();
  });
}

// Function to download file from URL
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    const request = protocol.get(url, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        downloadFile(response.headers.location, destPath)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }

      const fileStream = require('fs').createWriteStream(destPath);
      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });

      fileStream.on('error', (err) => {
        require('fs').unlink(destPath, () => { });
        reject(err);
      });
    });

    request.on('error', (err) => {
      reject(err);
    });
  });
}

// ============================================
// API ENDPOINTS
// ============================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main conversion endpoint
app.post('/api/convert', async (req, res) => {
  const { url } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (!isValidYouTubeUrl(url)) {
    return res.status(400).json({
      error: 'Invalid YouTube URL. Only YouTube links are supported.'
    });
  }

  let tempAudioPath = null;

  try {
    await ensureTempDir();

    console.log(`Converting audio from: ${url}`);

    // Get download URL from Cobalt API
    const cobaltResult = await getCobaltDownloadUrl(url);
    console.log('Got Cobalt download URL:', cobaltResult.url);

    // Generate temp filename
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(7);
    const safeFilename = sanitize(cobaltResult.filename || 'audio').substring(0, 100);
    tempAudioPath = path.join(TEMP_DIR, `${timestamp}-${randomId}.mp3`);

    // Download the audio file
    console.log('Downloading audio file...');
    await downloadFile(cobaltResult.url, tempAudioPath);
    console.log('Download complete!');

    // Send the file to user
    res.download(tempAudioPath, `${safeFilename}.mp3`, async (err) => {
      try {
        if (tempAudioPath) await fs.unlink(tempAudioPath).catch(() => { });
      } catch (cleanupError) {
        console.error('Cleanup error:', cleanupError.message);
      }

      if (err && !res.headersSent) {
        console.error('Download error:', err.message);
        res.status(500).json({ error: 'Download failed' });
      }
    });

  } catch (error) {
    console.error('Conversion error:', error.message);
    console.error('Full error:', error);

    try {
      if (tempAudioPath) await fs.unlink(tempAudioPath).catch(() => { });
    } catch { }

    if (!res.headersSent) {
      res.status(500).json({
        error: 'Conversion failed. Please check the URL and try again.'
      });
    }
  }
});

// ============================================
// STATIC FILE SERVING
// ============================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// STARTUP
// ============================================

async function startServer() {
  await ensureTempDir();

  setInterval(cleanupOldFiles, 15 * 60 * 1000);
  await cleanupOldFiles();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔═══════════════════════════════════════════════╗
║  YouTube to MP3 Converter                     ║
║  Running on port: ${PORT}                      ║
║                                               ║
║  ⚠️  FOR PERSONAL USE ONLY                    ║
║  Using Cobalt API                             ║
╚═══════════════════════════════════════════════╝
    `);
  });
}

startServer().catch(console.error);

process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  await cleanupOldFiles();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  await cleanupOldFiles();
  process.exit(0);
});
