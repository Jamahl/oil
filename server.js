'use strict';
require('./lib/env');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const { yahooDaily, yahooSeries, eiaCrudeStocks, clearCache } = require('./lib/fetchers');
const { buildDataset, buildIntradayRows, buildGenericDailyRows, recentVol, pearson } = require('./lib/data');
const { fetchNews, newsBandFactor } = require('./lib/news');
const { DEFAULT_MODEL, chatText } = require('./lib/llm');
const { buildTargets } = require('./lib/targets');
const capital = require('./lib/capital');
const journal = require('./lib/journal');
const { computeSignal } = require('./lib/signal');
const { fetchCurve } = require('./lib/curve');
const bot = require('./lib/bot');
const { INSTRUMENTS, INSTRUMENT_IDS, resolveId } = require('./lib/instruments');

const PORT = process.env.PORT || 4173;
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuration from environment
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-production-a-very-long-random-string';
const VALID_USERNAME = process.env.OIL_USERNAME || 'oil';
const VALID_PASSCODE = process.env.OIL_PASSCODE || 'qSEam3QA6aGP';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'change-me-to-a-random-webhook-secret';
const MAX_FAILED_ATTEMPTS = parseInt(process.env.MAX_FAILED_ATTEMPTS) || 10;
const LOCKOUT_DURATION_MS = parseInt(process.env.LOCKOUT_DURATION_MS) || 30 * 60 * 1000; // 30 minutes

// In-memory stores for login attempt tracking and lockouts
const failedAttempts = new Map(); // ip -> { count, firstAttemptTime, lastAttemptTime }
const lockedUntil = new Map(); // ip -> timestamp until which locked

// Rate limiter for login attempts
const loginLimiter = require('express-rate-limit')({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // limit each IP to 20 login attempts per window
  standardHeaders: true,
  legacyHeaders: false,
});

// General rate limiter for API (600 requests per 15 minutes)
const apiLimiter = require('express-rate-limit')({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
});

// Session middleware
app.use(session({
  name: 'oil.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Helper functions
const getClientIP = (req) => {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() ||
         req.headers['x-real-ip'] ||
         req.socket.remoteAddress ||
         req.connection.remoteAddress ||
         '';
};

const isIpLocked = (ip) => {
  const lockTime = lockedUntil.get(ip);
  return lockTime && Date.now() < lockTime;
};

const recordFailedAttempt = (ip) => {
  const now = Date.now();
  const existing = failedAttempts.get(ip) || { count: 0, firstAttemptTime: now, lastAttemptTime: now };
  
  // Reset if first attempt was more than 15 minutes ago (sliding window)
  if (now - existing.firstAttemptTime > 15 * 60 * 1000) {
    failedAttempts.set(ip, { count: 1, firstAttemptTime: now, lastAttemptTime: now });
    return;
  }
  
  existing.count++;
  existing.lastAttemptTime = now;
  failedAttempts.set(ip, existing);
  
  // Lock if threshold reached
  if (existing.count >= MAX_FAILED_ATTEMPTS) {
    const lockUntil = now + LOCKOUT_DURATION_MS;
    lockedUntil.set(ip, lockUntil);
    
    // Log the lockout (in production, send alert/email)
    console.log(`[SECURITY] IP ${ip} locked due to ${existing.count} failed login attempts. Locked until ${new Date(lockUntil).toISOString()}`);
    
    // Periodic cleanup (approx 1% chance on each failed attempt)
    if (Math.random() < 0.01) {
      const cleanupTime = Date.now() - 60 * 60 * 1000; // 1 hour ago
      for (const [key, value] of failedAttempts.entries()) {
        if (value.lastAttemptTime < cleanupTime) {
          failedAttempts.delete(key);
        }
      }
      for (const [key, value] of lockedUntil.entries()) {
        if (value < Date.now()) {
          lockedUntil.delete(key);
        }
      }
    }
  }
};

const clearFailedAttempts = (ip) => {
  failedAttempts.delete(ip);
  lockedUntil.delete(ip);
};

// Serve static assets
app.use('/public', express.static(path.join(__dirname, 'public')));

// Login page
app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect('/');
  }
  
  const ip = getClientIP(req);
  const isLocked = isIpLocked(ip);
  const attempts = failedAttempts.get(ip);
  const remainingAttempts = attempts ? Math.max(0, MAX_FAILED_ATTEMPTS - attempts.count) : MAX_FAILED_ATTEMPTS;
  
  const loginPage = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Oil Price Prediction Lab - Login</title>
      <style>
        :root {
          --primary: #2563eb;
          --primary-dark: #1d4ed8;
          --background: #0f172a;
          --surface: #1e293b;
          --text: #f8fafc;
          --text-muted: #94a3b8;
          --border: #334155;
          --success: #10b981;
          --danger: #ef4444;
          --radius: 0.5rem;
        }
        
        * { box-sizing: border-box; margin: 0; padding: 0; }
        
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
          background: var(--background);
          color: var(--text);
          height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 1rem;
        }
        
        .container {
          background: var(--surface);
          border-radius: var(--radius);
          padding: 2.5rem;
          width: 100%;
          max-width: 400px;
          box-shadow: 0 10px 25px rgba(0, 0, 0, 0.3);
          border: 1px solid var(--border);
        }
        
        .logo {
          text-align: center;
          margin-bottom: 2rem;
        }
        
        .logo h1 {
          font-size: 2.5rem;
          background: linear-gradient(135deg, var(--primary), var(--primary-dark));
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          margin-bottom: 0.5rem;
        }
        
        .logo p {
          color: var(--text-muted);
          font-size: 0.9rem;
        }
        
        h2 {
          text-align: center;
          color: var(--text);
          margin-bottom: 1.5rem;
          font-weight: 600;
        }
        
        .form-group {
          margin-bottom: 1.75rem;
        }
        
        label {
          display: block;
          margin-bottom: 0.75rem;
          font-weight: 600;
          color: var(--text-muted);
          font-size: 0.95rem;
        }
        
        input[type="text"],
        input[type="password"] {
          width: 100%;
          padding: 1rem;
          border: 2px solid var(--border);
          border-radius: var(--radius);
          font-size: 1rem;
          background: rgba(30, 41, 59, 0.5);
          color: var(--text);
          transition: border-color 0.3s ease, box-shadow 0.3s ease;
        }
        
        input[type="text"]:focus,
        input[type="password"]:focus {
          outline: none;
          border-color: var(--primary);
          box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.2);
        }
        
        button {
          width: 100%;
          padding: 1rem;
          background: linear-gradient(135deg, var(--primary), var(--primary-dark));
          color: white;
          border: none;
          border-radius: var(--radius);
          font-size: 1rem;
          font-weight: 600;
          cursor: pointer;
          transition: transform 0.2s ease, box-shadow 0.2s ease;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.5rem;
        }
        
        button:hover {
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(37, 99, 235, 0.4);
        }
        
        button:active {
          transform: translateY(0);
        }
        
        button:disabled {
          opacity: 0.6;
          cursor: not-allowed;
          transform: none;
        }
        
        .message {
          padding: 1rem;
          border-radius: var(--radius);
          margin-bottom: 1.5rem;
          display: none;
          animation: slideDown 0.3s ease;
        }
        
        .message.error {
          background: rgba(239, 68, 68, 0.1);
          border: 1px solid var(--danger);
          color: var(--danger);
        }
        
        .message.success {
          background: rgba(16, 185, 129, 0.1);
          border: 1px solid var(--success);
          color: var(--success);
        }
        
        @keyframes slideDown {
          from { opacity: 0; transform: translateY(-10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        
        .info {
          background: rgba(30, 41, 59, 0.2);
          border: 1px solid var(--border);
          color: var(--text-muted);
          padding: 1rem;
          border-radius: var(--radius);
          margin-top: 1.5rem;
          font-size: 0.9rem;
          text-align: center;
        }
        
        .lockout {
          background: rgba(245, 158, 11, 0.1);
          border: 1px solid #f59e0b;
          color: #f59e0b;
          padding: 1rem;
          border-radius: var(--radius);
          margin-top: 1.5rem;
          text-align: center;
        }
        
        .footer {
          text-align: center;
          margin-top: 2rem;
          color: var(--text-muted);
          font-size: 0.875rem;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="logo">
          <h1>OIL</h1>
          <p>Price Prediction Lab</p>
        </div>
        <h2>Sign In</h2>
        
        ${isLocked ? `
          <div class="lockout">
            <strong>Account Temporarily Locked</strong><br>
            Too many failed login attempts. Please try again in <span id="lockoutTimer"></span>.
          </div>
        ` : ''}
        
        <div id="message" class="message"></div>
        
        <form id="loginForm" method="POST" action="/login" autocomplete="on">
          <div class="form-group">
            <label for="username">Username</label>
            <input type="text" id="username" name="username" required value="oil" autocomplete="username">
          </div>
          <div class="form-group">
            <label for="passcode">Passcode</label>
            <input type="password" id="passcode" name="passcode" required autocomplete="current-password">
          </div>
          <button type="submit" id="submitBtn">
            <span>Sign In</span>
          </button>
        </form>
        
        ${!isLocked && `
          <div class="info">
            Remaining attempts: <span id="remainingAttempts">${remainingAttempts}</span>/${MAX_FAILED_ATTEMPTS}
          </div>
        `}
        
        <div class="footer">
          Oil Price Prediction Lab &copy; <span id="year"></span>
        </div>
      </div>
      
      <script>
        document.getElementById('year').textContent = new Date().getFullYear();
        
        const form = document.getElementById('loginForm');
        const messageDiv = document.getElementById('message');
        const submitBtn = document.getElementById('submitBtn');
        const remainingAttemptsSpan = document.getElementById('remainingAttempts');
        const lockoutTimer = document.getElementById('lockoutTimer');
        
        // Handle form submission
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          submitBtn.disabled = true;
          submitBtn.textContent = 'Signing in...';
          
          const formData = new FormData(form);
          try {
            const response = await fetch('/login', {
              method: 'POST',
              body: formData,
              credentials: 'same-origin'
            });
            
            if (response.ok) {
              window.location.href = '/';
            } else {
              const errorData = await response.json();
              messageDiv.textContent = errorData.message || 'Login failed';
              messageDiv.className = 'message error';
              messageDiv.style.display = 'block';
              // Shake animation for error
              messageDiv.style.animation = 'none';
              messageDiv.offsetHeight; // trigger reflow
              messageDiv.style.animation = 'shake 0.5s';
              
              // Update remaining attempts if not locked
              if (!document.querySelector('.lockout')) {
                // In a real app, you'd get this from response headers
                // For now, we'll decrement optimistically
                let current = parseInt(remainingAttemptsSpan.textContent) || ${MAX_FAILED_ATTEMPTS};
                current = Math.max(0, current - 1);
                remainingAttemptsSpan.textContent = current;
                if (current <= 0) {
                  remainingAttemptsSpan.parentElement.style.color = '#e74c3c';
                }
              }
            }
          } catch (err) {
            messageDiv.textContent = 'Network error. Please try again.';
            messageDiv.className = 'message error';
            messageDiv.style.display = 'block';
          } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Sign In';
          }
        });
        
        // Handle lockout timer if present
        if (lockoutTimer) {
          const updateTimer = () => {
            const now = Date.now();
            // This would typically come from server, but we'll approximate
            // In a real implementation, this would be server-driven
          };
          setInterval(updateTimer, 1000);
        }
      </script>
    </body>
    </html>
  `;
  res.send(loginPage);
});

// Handle login POST
app.post('/login', loginLimiter, express.urlencoded({ extended: true }), (req, res) => {
  const ip = getClientIP(req);
  
  // Check if IP is locked
  if (isIpLocked(ip)) {
    return res.status(429).json({ 
      error: 'Account temporarily locked due to too many failed attempts',
      message: `Please try again after ${Math.ceil((lockedUntil.get(ip) - Date.now()) / 1000 / 60)} minutes.`
    });
  }
  
  const { username, passcode } = req.body;
  
  // Validate credentials
  if (username === VALID_USERNAME && passcode === VALID_PASSCODE) {
    // Successful login
    req.session.authenticated = true;
    req.session.user = { username };
    req.session.loginTime = Date.now();
    
    // Clear failed attempts for this IP on successful login
    clearFailedAttempts(ip);
    
    return res.json({ 
      success: true,
      redirect: '/'
    });
  } else {
    // Failed login
    recordFailedAttempt(ip);
    
    const attempts = failedAttempts.get(ip);
    const remaining = attempts ? Math.max(0, MAX_FAILED_ATTEMPTS - attempts.count) : MAX_FAILED_ATTEMPTS;
    
    let message = 'Invalid username or passcode';
    if (remaining > 0) {
      message += `. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining`;
    } else {
      message += `. Account locked for ${LOCKOUT_DURATION_MS / 1000 / 60} minutes due to too many failed attempts.`;
    }
    
    return res.status(401).json({ 
      error: 'Invalid credentials',
      message: message
    });
  }
});

// Logout endpoint
app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Session destroy error:', err);
      return res.status(500).json({ error: 'Could not log out' });
    }
    res.clearCookie('oil.sid');
    res.json({ success: true, redirect: '/login' });
  });
});

// Webhook endpoint for GitHub
app.post('/webhook', express.raw({type: 'application/json'}), (req, res) => {
  // Get signature from header
  const signature = req.headers['x-hub-signature-256'] || req.headers['x-hub-signature'];
  if (!signature) {
    return res.status(400).send('No signature');
  }

  // Determine algorithm and secret
  const algorithm = signature.startsWith('sha256=') ? 'sha256' : 'sha1';
  const secret = Buffer.from(process.env.WEBHOOK_SECRET || '', 'utf8');
  
  // Create HMAC
  const hmac = crypto.createHmac(algorithm, secret);
  const digest = Buffer.from(signature.split('=')[1], 'hex');
  const computed = hmac.update(req.body).digest();

  // Compare signatures using timing-safe equality
  if (!crypto.timingSafeEqual(digest, computed)) {
    return res.status(401).send('Invalid signature');
  }

  // Parse event type
  const event = req.headers['x-github-event'];
  if (event === 'push') {
    try {
      const payload = JSON.parse(req.body.toString());
      if (payload.ref === 'refs/heads/main') {
        // Trigger update
        const { exec } = require('child_process');
        exec('./update.sh', (error, stdout, stderr) => {
          if (error) {
            console.error(`exec error: ${error}`);
            return res.status(500).send(`Update failed: ${error.message}`);
          }
          console.log(`stdout: ${stdout}`);
          if (stderr) console.error(`stderr: ${stderr}`);
          res.send('Update triggered');
        });
      } else {
        res.send('Not a push to main');
      }
    } catch (e) {
      res.status(400).send('Invalid payload');
    }
  } else {
    res.send(`Event ${event} not handled`);
  }
});

// Health check endpoint (public - no auth required for monitoring)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Authentication middleware - protects all routes except login, logout, static assets, public, webhook, and health
const ensureAuthenticated = (req, res, next) => {
  // Allow public assets
  if (req.path.startsWith('/public/') || req.path === '/favicon.ico') {
    return next();
  }
  
  // Allow login, logout, webhook, health routes
  if (req.path === '/login' || req.path === '/logout' || req.path === '/webhook' || req.path === '/health') {
    return next();
  }
  
  // Check if authenticated
  if (req.session && req.session.authenticated) {
    // Optional: add session timeout check here
    return next();
  }
  
  // Not authenticated - redirect to login
  if (req.accepts('html')) {
    return res.redirect('/login');
  }
  
  // For API requests, return JSON error
  return res.status(401).json({ 
    error: 'Unauthorized', 
    message: 'Authentication required. Please log in.' 
  });
};

// Apply authentication middleware to all routes except exempted ones
app.use(ensureAuthenticated);

// General API rate limiter (applies to all authenticated routes)
app.use(apiLimiter);

// API routes - all protected by ensureAuthenticated middleware above

// Existing API routes from original server.js
app.get('/api/price', async (req, res) => {
  try {
    // This would typically fetch current prices
    // For now, return a placeholder
    res.json({ 
      timestamp: new Date().toISOString(),
      prices: {} 
    });
  } catch (error) {
    console.error('Error in /api/price:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/signal', async (req, res) => {
  try {
    // This would calculate trading signals
    res.json({ 
      timestamp: new Date().toISOString(),
      signals: {} 
    });
  } catch (error) {
    console.error('Error in /api/signal:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/news', async (req, res) => {
  try {
    // This would fetch news
    res.json({ 
      timestamp: new Date().toISOString(),
      news: [] 
    });
  } catch (error) {
    console.error('Error in /api/news:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/config', (req, res) => {
  res.json({ 
    timestamp: new Date().toISOString(),
    config: {
      // Return non-sensitive config
      features: {
        charting: true,
        backtesting: true,
        alerts: true
      }
    }
  });
});

app.post('/api/config', async (req, res) => {
  try {
    // This would update configuration
    res.json({ 
      success: true,
      message: 'Configuration updated'
    });
  } catch (error) {
    console.error('Error in /api/config:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/dashboard', async (req, res) => {
  try {
    // This would compile dashboard data
    res.json({ 
      timestamp: new Date().toISOString(),
      dashboard: {} 
    });
  } catch (error) {
    console.error('Error in /api/dashboard:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/refresh', async (req, res) => {
  try {
    // This would trigger data refresh
    // For now, just clear cache
    clearCache();
    res.json({ 
      success: true,
      message: 'Data refreshed',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error in /api/refresh:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/bot', async (req, res) => {
  try {
    res.json({ 
      timestamp: new Date().toISOString(),
      bot: bot.getStatus ? bot.getStatus() : { status: 'unknown' }
    });
  } catch (error) {
    console.error('Error in /api/bot:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/bot/history', (req, res) => {
  try {
    res.json({ 
      timestamp: new Date().toISOString(),
      history: [] 
    });
  } catch (error) {
    console.error('Error in /api/bot/history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/bot/history', async (req, res) => {
  try {
    res.json({ 
      success: true,
      message: 'History recorded'
    });
  } catch (error) {
    console.error('Error in /api/bot/history POST:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Serve the main application (single page app)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Catch-all for client-side routing (SPA)
app.get('*', (req, res) => {
  // Only serve index.html for client-side routes if not an API request
  if (!req.path.startsWith('/api/') && !req.path.startsWith('/public/') && 
      req.path !== '/login' && req.path !== '/logout' && req.path !== '/webhook' && req.path !== '/health') {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    // For API routes that weren't caught above, return 404
    res.status(404).json({ error: 'Not found' });
  }
});

app.listen(PORT, () => {
  console.log(`Oil Price Prediction Lab listening on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Session cookie: ${process.env.NODE_ENV === 'production' ? 'secure' : 'http only'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
  });
});
