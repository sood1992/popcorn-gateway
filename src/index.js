// =============================================================================
// POPCORN GPS COLLAR V6.0 - GATEWAY SERVER
// =============================================================================
// Deploy to Railway.app (free tier)
// 
// Setup:
// 1. Push this code to GitHub
// 2. Connect Railway to your GitHub repo
// 3. Add environment variables (see .env.example)
// 4. Deploy!
// =============================================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// =============================================================================
// CONFIGURATION
// =============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const HMAC_KEY = process.env.HMAC_KEY;

// Validate required environment variables
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('ERROR: Missing required environment variables!');
    console.error('Required: SUPABASE_URL, SUPABASE_SERVICE_KEY');
    process.exit(1);
}

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// =============================================================================
// MIDDLEWARE
// =============================================================================

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Request logging
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.path} - ${req.ip}`);
    next();
});

// =============================================================================
// HMAC VERIFICATION (FIX #6 - matches firmware)
// =============================================================================

function verifyHMAC(payload, providedSignature) {
    if (!HMAC_KEY) {
        console.warn('[SECURITY] WARNING: HMAC_KEY not configured - skipping verification');
        return true;
    }
    
    if (!providedSignature) {
        console.warn('[SECURITY] No signature provided');
        return false;
    }
    
    // Reconstruct payload without signature for verification
    const payloadCopy = { ...payload };
    delete payloadCopy.signature;
    
    const dataString = JSON.stringify(payloadCopy);
    
    // djb2 hash algorithm (same as firmware)
    let hash = 5381;
    for (let i = 0; i < dataString.length; i++) {
        hash = ((hash << 5) + hash) + dataString.charCodeAt(i);
        hash = hash >>> 0; // Convert to unsigned 32-bit
    }
    
    // Mix in the key
    for (let i = 0; i < HMAC_KEY.length; i++) {
        hash = ((hash << 5) + hash) + HMAC_KEY.charCodeAt(i);
        hash = hash >>> 0;
    }
    
    const calculatedSignature = hash >>> 0;
    
    // Compare (firmware sends as integer)
    const matches = calculatedSignature === parseInt(providedSignature);
    
    if (!matches) {
        console.warn(`[SECURITY] Signature mismatch. Expected: ${calculatedSignature}, Got: ${providedSignature}`);
    }
    
    return matches;
}

// =============================================================================
// ROUTES: Health Check
// =============================================================================

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'Popcorn GPS Collar Gateway',
        version: '6.0.0',
        timestamp: new Date().toISOString(),
        supabase: SUPABASE_URL ? 'configured' : 'missing',
        hmac: HMAC_KEY ? 'configured' : 'disabled'
    });
});

app.get('/', (req, res) => {
    res.json({
        service: 'Popcorn GPS Collar Gateway',
        version: '6.0.0',
        endpoints: {
            health: 'GET /health',
            telemetry: 'POST /telemetry',
            deviceStatus: 'GET /device/:deviceId/status',
            locations: 'GET /device/:deviceId/locations',
            sleepHistory: 'GET /device/:deviceId/sleep',
            scratchHistory: 'GET /device/:deviceId/scratches',
            walkHistory: 'GET /device/:deviceId/walks',
            startWalk: 'POST /device/:deviceId/walk/start',
            endWalk: 'POST /device/:deviceId/walk/end'
        }
    });
});

// =============================================================================
// ROUTES: Telemetry (Main endpoint - receives data from collar)
// =============================================================================

app.post('/telemetry', async (req, res) => {
    try {
        const payload = req.body;
        
        // Validate required fields
        if (!payload.device_id) {
            return res.status(400).json({ error: 'Missing device_id' });
        }
        
        // Verify HMAC signature
        if (!verifyHMAC(payload, payload.signature)) {
            console.warn(`[TELEMETRY] Invalid signature from ${payload.device_id}`);
            return res.status(401).json({ error: 'Invalid signature' });
        }
        
        const deviceId = payload.device_id;
        console.log(`[TELEMETRY] Valid payload from ${deviceId}`);
        
        // Build status update object
        const statusUpdate = {
            device_id: deviceId,
            
            // GPS
            latitude: payload.gps?.lat || null,
            longitude: payload.gps?.lon || null,
            altitude: payload.gps?.alt || null,
            speed: payload.gps?.speed || null,
            hdop: payload.gps?.hdop || null,
            satellites: payload.gps?.satellites || 0,
            gps_valid: payload.gps?.valid || false,
            
            // Accelerometer
            accel_x: payload.accel?.x || null,
            accel_y: payload.accel?.y || null,
            accel_z: payload.accel?.z || null,
            accel_magnitude: payload.accel?.magnitude || null,
            accel_variance: payload.accel?.variance || null,
            
            // Activity
            activity_class: payload.activity?.class ?? 0,
            activity_name: payload.activity?.name || 'unknown',
            session_steps: payload.activity?.session_steps || 0,
            today_steps: payload.activity?.today_steps || 0,
            
            // Location
            is_home: payload.location?.is_home ?? true,
            is_escaped: payload.location?.is_escaped ?? false,
            distance_from_home: payload.location?.distance_home || null,
            
            // Battery
            battery_voltage: payload.battery?.voltage || null,
            battery_percent: payload.battery?.percent || null,
            
            // Network
            signal_strength: payload.network?.signal || null,
            network_operator: payload.network?.operator || null,
            
            // Sleep
            sleep_active: payload.sleep?.active || false,
            sleep_quality: payload.sleep?.quality || null,
            respiratory_rate: payload.sleep?.respiratory_rate || null,
            restless_count: payload.sleep?.restless_count || 0,
            
            // Walk
            walk_active: payload.walk?.active || false,
            walk_duration: payload.walk?.duration || 0,
            walk_distance: payload.walk?.distance || 0,
            walk_stops: payload.walk?.stops || 0,
            
            // Scratch
            scratch_detected: payload.scratch?.detected || false,
            today_scratch_count: payload.scratch?.today_count || 0,
            
            // Health
            anomaly_detected: payload.health?.anomaly || false,
            anomaly_type: payload.health?.anomaly_type || null,
            activity_deviation: payload.health?.deviation || null,
            
            // System
            boot_count: payload.boot_count || 0,
            firmware_version: payload.firmware || null,
            last_seen_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
        
        // Update device status (upsert)
        const { error: statusError } = await supabase
            .from('device_status')
            .upsert(statusUpdate, { onConflict: 'device_id' });
        
        if (statusError) {
            console.error('[TELEMETRY] Status update error:', statusError);
        }
        
        // Insert location record if GPS valid
        if (payload.gps?.valid && payload.gps?.lat && payload.gps?.lon) {
            const { error: locationError } = await supabase
                .from('locations')
                .insert({
                    device_id: deviceId,
                    latitude: payload.gps.lat,
                    longitude: payload.gps.lon,
                    altitude: payload.gps.alt,
                    speed: payload.gps.speed,
                    hdop: payload.gps.hdop,
                    satellites: payload.gps.satellites,
                    activity_class: payload.activity?.class,
                    is_home: payload.location?.is_home,
                    is_escaped: payload.location?.is_escaped
                });
            
            if (locationError) {
                console.error('[TELEMETRY] Location insert error:', locationError);
            }
        }
        
        // Record scratch event if detected
        if (payload.scratch?.detected) {
            const { error: scratchError } = await supabase
                .from('scratch_events')
                .insert({
                    device_id: deviceId,
                    frequency_hz: payload.scratch.frequency,
                    confidence: payload.scratch.confidence,
                    latitude: payload.gps?.lat,
                    longitude: payload.gps?.lon
                });
            
            if (scratchError) {
                console.error('[TELEMETRY] Scratch insert error:', scratchError);
            }
            
            // Update daily scratch count
            const today = new Date().toISOString().split('T')[0];
            await supabase
                .from('scratch_daily')
                .upsert({
                    device_id: deviceId,
                    date: today,
                    total_count: payload.scratch.today_count,
                    max_frequency: payload.scratch.frequency
                }, { onConflict: 'device_id,date' });
        }
        
        // Record anomaly if detected
        if (payload.health?.anomaly) {
            // Check if already logged today
            const today = new Date().toISOString().split('T')[0];
            const { data: existing } = await supabase
                .from('anomaly_log')
                .select('id')
                .eq('device_id', deviceId)
                .eq('anomaly_type', payload.health.anomaly_type)
                .gte('detected_at', today)
                .limit(1);
            
            if (!existing || existing.length === 0) {
                await supabase
                    .from('anomaly_log')
                    .insert({
                        device_id: deviceId,
                        anomaly_type: payload.health.anomaly_type,
                        deviation_percent: payload.health.deviation
                    });
            }
        }
        
        res.json({ 
            status: 'ok',
            device_id: deviceId,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('[TELEMETRY] Error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// =============================================================================
// ROUTES: Device Status
// =============================================================================

app.get('/device/:deviceId/status', async (req, res) => {
    try {
        const { deviceId } = req.params;
        
        const { data, error } = await supabase
            .from('device_status')
            .select('*')
            .eq('device_id', deviceId)
            .single();
        
        if (error || !data) {
            return res.status(404).json({ error: 'Device not found' });
        }
        
        res.json(data);
        
    } catch (error) {
        console.error('[STATUS] Error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// =============================================================================
// ROUTES: Location History
// =============================================================================

app.get('/device/:deviceId/locations', async (req, res) => {
    try {
        const { deviceId } = req.params;
        const { hours = 24, limit = 500 } = req.query;
        
        const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
        
        const { data, error } = await supabase
            .from('locations')
            .select('*')
            .eq('device_id', deviceId)
            .gte('recorded_at', since)
            .order('recorded_at', { ascending: false })
            .limit(parseInt(limit));
        
        if (error) {
            return res.status(500).json({ error: error.message });
        }
        
        res.json({
            device_id: deviceId,
            count: data.length,
            locations: data
        });
        
    } catch (error) {
        console.error('[LOCATIONS] Error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// =============================================================================
// ROUTES: Sleep History
// =============================================================================

app.get('/device/:deviceId/sleep', async (req, res) => {
    try {
        const { deviceId } = req.params;
        const { days = 7 } = req.query;
        
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        
        const { data, error } = await supabase
            .from('sleep_sessions')
            .select('*')
            .eq('device_id', deviceId)
            .gte('started_at', since)
            .order('started_at', { ascending: false });
        
        if (error) {
            return res.status(500).json({ error: error.message });
        }
        
        // Calculate averages
        const avgQuality = data.length > 0
            ? data.reduce((sum, s) => sum + (s.quality_score || 0), 0) / data.length
            : 0;
        
        res.json({
            device_id: deviceId,
            sessions: data,
            summary: {
                total_sessions: data.length,
                avg_quality: avgQuality.toFixed(1),
                avg_duration: data.length > 0
                    ? Math.round(data.reduce((sum, s) => sum + (s.duration_minutes || 0), 0) / data.length)
                    : 0
            }
        });
        
    } catch (error) {
        console.error('[SLEEP] Error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// =============================================================================
// ROUTES: Scratch History
// =============================================================================

app.get('/device/:deviceId/scratches', async (req, res) => {
    try {
        const { deviceId } = req.params;
        const { days = 7 } = req.query;
        
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        
        const { data, error } = await supabase
            .from('scratch_daily')
            .select('*')
            .eq('device_id', deviceId)
            .gte('date', since)
            .order('date', { ascending: false });
        
        if (error) {
            return res.status(500).json({ error: error.message });
        }
        
        const totalScratches = data.reduce((sum, d) => sum + (d.total_count || 0), 0);
        
        res.json({
            device_id: deviceId,
            daily: data,
            summary: {
                total: totalScratches,
                avg_per_day: data.length > 0 ? (totalScratches / data.length).toFixed(1) : 0
            }
        });
        
    } catch (error) {
        console.error('[SCRATCHES] Error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// =============================================================================
// ROUTES: Walk History
// =============================================================================

app.get('/device/:deviceId/walks', async (req, res) => {
    try {
        const { deviceId } = req.params;
        const { days = 30 } = req.query;
        
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        
        const { data, error } = await supabase
            .from('walk_sessions')
            .select('*')
            .eq('device_id', deviceId)
            .gte('started_at', since)
            .order('started_at', { ascending: false });
        
        if (error) {
            return res.status(500).json({ error: error.message });
        }
        
        const totalDistance = data.reduce((sum, w) => sum + (w.distance_meters || 0), 0);
        
        res.json({
            device_id: deviceId,
            walks: data,
            summary: {
                total_walks: data.length,
                total_distance_km: (totalDistance / 1000).toFixed(2),
                avg_duration_min: data.length > 0
                    ? Math.round(data.reduce((sum, w) => sum + (w.duration_seconds || 0), 0) / data.length / 60)
                    : 0
            }
        });
        
    } catch (error) {
        console.error('[WALKS] Error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// =============================================================================
// ROUTES: Walk Management (Start/End from app)
// =============================================================================

app.post('/device/:deviceId/walk/start', async (req, res) => {
    try {
        const { deviceId } = req.params;
        
        // Get current device status
        const { data: status } = await supabase
            .from('device_status')
            .select('latitude, longitude')
            .eq('device_id', deviceId)
            .single();
        
        // Create walk session
        const { data, error } = await supabase
            .from('walk_sessions')
            .insert({
                device_id: deviceId,
                started_at: new Date().toISOString(),
                start_lat: status?.latitude,
                start_lon: status?.longitude
            })
            .select()
            .single();
        
        if (error) {
            return res.status(500).json({ error: error.message });
        }
        
        res.json({
            status: 'ok',
            walk_id: data.id,
            started_at: data.started_at
        });
        
    } catch (error) {
        console.error('[WALK START] Error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/device/:deviceId/walk/end', async (req, res) => {
    try {
        const { deviceId } = req.params;
        const { walk_id } = req.body;
        
        // Get current device status
        const { data: status } = await supabase
            .from('device_status')
            .select('latitude, longitude, walk_duration, walk_distance, walk_stops')
            .eq('device_id', deviceId)
            .single();
        
        // Get walk session
        const { data: walk } = await supabase
            .from('walk_sessions')
            .select('*')
            .eq('id', walk_id)
            .single();
        
        if (!walk) {
            return res.status(404).json({ error: 'Walk session not found' });
        }
        
        // Calculate grade
        const duration = status?.walk_duration || 0;
        const distance = status?.walk_distance || 0;
        const stops = status?.walk_stops || 0;
        
        let gradeScore = 100;
        gradeScore -= stops * 5;  // -5 per stop
        if (duration < 900) gradeScore -= 20;  // <15 min walk
        if (distance < 500) gradeScore -= 15;  // <500m
        gradeScore = Math.max(0, Math.min(100, gradeScore));
        
        let grade = 'A';
        if (gradeScore < 90) grade = 'B';
        if (gradeScore < 70) grade = 'C';
        if (gradeScore < 50) grade = 'F';
        
        // Update walk session
        const { error } = await supabase
            .from('walk_sessions')
            .update({
                ended_at: new Date().toISOString(),
                duration_seconds: duration,
                distance_meters: distance,
                end_lat: status?.latitude,
                end_lon: status?.longitude,
                stop_count: stops,
                grade: grade,
                grade_score: gradeScore
            })
            .eq('id', walk_id);
        
        if (error) {
            return res.status(500).json({ error: error.message });
        }
        
        res.json({
            status: 'ok',
            walk_id: walk_id,
            grade: grade,
            grade_score: gradeScore,
            duration_minutes: Math.round(duration / 60),
            distance_meters: Math.round(distance)
        });
        
    } catch (error) {
        console.error('[WALK END] Error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// =============================================================================
// START SERVER
// =============================================================================

app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║       POPCORN GPS COLLAR GATEWAY V6.0                      ║
╠════════════════════════════════════════════════════════════╣
║  Status: Running                                           ║
║  Port: ${PORT}                                                ║
║  Supabase: ${SUPABASE_URL ? 'Connected' : 'NOT CONFIGURED'}                             ║
║  HMAC: ${HMAC_KEY ? 'Enabled' : 'DISABLED (insecure!)'}                                   ║
╚════════════════════════════════════════════════════════════╝
    `);
});

module.exports = app;
