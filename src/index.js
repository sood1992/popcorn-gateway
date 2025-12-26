require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const hmacKey = process.env.HMAC_KEY || '';

let supabase = null;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
}

// HMAC verification (djb2 hash - matches firmware)
function verifyHMAC(data, providedSignature) {
  if (!hmacKey) return true;
  
  const message = `${data.device_id}:${data.timestamp}:${data.boot_count}`;
  let hash = 5381;
  const combined = message + hmacKey;
  for (let i = 0; i < combined.length; i++) {
    hash = ((hash << 5) + hash) + combined.charCodeAt(i);
    hash = hash & 0xFFFFFFFF;
  }
  const expected = (hash >>> 0).toString(16).padStart(8, '0');
  return expected === providedSignature;
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Popcorn GPS Collar Gateway',
    version: '6.1.0',
    features: ['anti-cheat', 'walk-verification'],
    supabase: supabase ? 'configured' : 'missing',
    hmac: hmacKey ? 'configured' : 'disabled'
  });
});

// Main telemetry endpoint
app.post('/telemetry', async (req, res) => {
  try {
    const data = req.body;
    
    if (!data || !data.device_id) {
      return res.status(400).json({ error: 'Missing device_id' });
    }

    // Verify HMAC
    if (hmacKey && data.signature) {
      if (!verifyHMAC(data, data.signature)) {
        console.log('HMAC verification failed');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    if (!supabase) {
      return res.status(500).json({ error: 'Database not configured' });
    }

    // Upsert device status with anti-cheat fields
    const { error: statusError } = await supabase
      .from('device_status')
      .upsert({
        device_id: data.device_id,
        latitude: data.latitude,
        longitude: data.longitude,
        altitude: data.altitude,
        speed: data.speed,
        hdop: data.hdop,
        satellites: data.satellites,
        gps_valid: data.gps_valid,
        accel_x: data.accel_x,
        accel_y: data.accel_y,
        accel_z: data.accel_z,
        accel_magnitude: data.accel_magnitude,
        accel_variance: data.accel_variance,
        activity_class: data.activity_class,
        activity_name: data.activity_name,
        session_steps: data.session_steps,
        today_steps: data.today_steps,
        is_home: data.is_home,
        is_escaped: data.is_escaped,
        distance_from_home: data.distance_from_home,
        battery_voltage: data.battery_voltage,
        battery_percent: data.battery_percent,
        signal_strength: data.signal_strength,
        network_operator: data.network_operator,
        sleep_active: data.sleep_active,
        sleep_quality: data.sleep_quality,
        respiratory_rate: data.respiratory_rate,
        restless_count: data.restless_count,
        walk_active: data.walk_active,
        walk_duration: data.walk_duration,
        walk_distance: data.walk_distance,
        walk_stops: data.walk_stops,
        // Anti-cheat fields
        walk_verification_status: data.walk_verification_status || 'not_walking',
        walk_quality_score: data.walk_quality_score || 0,
        carried_seconds: data.carried_seconds || 0,
        vehicle_seconds: data.vehicle_seconds || 0,
        actual_walk_seconds: data.actual_walk_seconds || 0,
        cheat_flags: data.cheat_flags || 0,
        // Other fields
        scratch_detected: data.scratch_detected,
        today_scratch_count: data.today_scratch_count,
        anomaly_detected: data.anomaly_detected,
        anomaly_type: data.anomaly_type,
        boot_count: data.boot_count,
        firmware_version: data.firmware_version,
        last_seen_at: new Date().toISOString()
      }, { onConflict: 'device_id' });

    if (statusError) {
      console.error('Status upsert error:', statusError);
    }

    // Insert location if GPS valid
    if (data.gps_valid && data.latitude && data.longitude) {
      await supabase.from('locations').insert({
        device_id: data.device_id,
        latitude: data.latitude,
        longitude: data.longitude,
        altitude: data.altitude,
        speed: data.speed,
        hdop: data.hdop,
        satellites: data.satellites,
        activity_class: data.activity_class,
        is_home: data.is_home,
        is_escaped: data.is_escaped
      });
    }

    // Insert scratch event if detected
    if (data.scratch_detected) {
      await supabase.from('scratch_events').insert({
        device_id: data.device_id,
        intensity: data.scratch_intensity || 1.0,
        duration_ms: data.scratch_duration || 500
      });
    }

    // Insert anomaly if detected
    if (data.anomaly_detected && data.anomaly_type) {
      await supabase.from('anomaly_log').insert({
        device_id: data.device_id,
        anomaly_type: data.anomaly_type,
        severity: data.anomaly_severity || 'medium',
        details: { deviation: data.activity_deviation }
      });
    }

    res.json({ status: 'ok', received: new Date().toISOString() });

  } catch (error) {
    console.error('Telemetry error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// End walk session with anti-cheat data
app.post('/device/:deviceId/walk/end', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: 'Database not configured' });
    }

    const { deviceId } = req.params;
    const walkData = req.body;

    // Calculate grade based on quality score
    let grade = 'F';
    const score = walkData.quality_score || 0;
    if (score >= 90) grade = 'A';
    else if (score >= 70) grade = 'B';
    else if (score >= 50) grade = 'C';

    // Calculate carried percentage
    const totalSeconds = walkData.duration_seconds || 1;
    const carriedPercent = ((walkData.carried_seconds || 0) / totalSeconds) * 100;
    const actualWalkPercent = ((walkData.actual_walk_seconds || 0) / totalSeconds) * 100;

    // Build cheat summary
    let cheatSummary = [];
    const flags = walkData.cheat_flags || 0;
    if (flags & 0x01) cheatSummary.push('carrying_detected');
    if (flags & 0x02) cheatSummary.push('vehicle_detected');
    if (flags & 0x04) cheatSummary.push('excessive_stops');
    if (flags & 0x08) cheatSummary.push('leash_only');

    const { data, error } = await supabase
      .from('walk_sessions')
      .insert({
        device_id: deviceId,
        started_at: walkData.started_at || new Date(Date.now() - (walkData.duration_seconds * 1000)).toISOString(),
        ended_at: new Date().toISOString(),
        duration_seconds: walkData.duration_seconds,
        distance_meters: walkData.distance_meters,
        stop_count: walkData.stop_count,
        grade: grade,
        grade_score: score,
        // Anti-cheat fields
        verification_status: walkData.verification_status || 'pending',
        quality_score: score,
        carried_seconds: walkData.carried_seconds || 0,
        carried_percent: carriedPercent,
        vehicle_seconds: walkData.vehicle_seconds || 0,
        vehicle_detected: (flags & 0x02) !== 0,
        actual_walk_seconds: walkData.actual_walk_seconds || 0,
        actual_walk_percent: actualWalkPercent,
        cheat_flags: flags,
        cheat_summary: cheatSummary.join(', ') || null
      })
      .select()
      .single();

    if (error) {
      console.error('Walk session error:', error);
      return res.status(500).json({ error: error.message });
    }

    res.json({ status: 'ok', walk: data, grade: grade });

  } catch (error) {
    console.error('Walk end error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get device status
app.get('/device/:deviceId/status', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'No database' });

    const { data, error } = await supabase
      .from('device_status')
      .select('*')
      .eq('device_id', req.params.deviceId)
      .single();

    if (error) return res.status(404).json({ error: 'Device not found' });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get walks with anti-cheat data
app.get('/device/:deviceId/walks', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'No database' });

    const { data, error } = await supabase
      .from('walk_sessions')
      .select('*')
      .eq('device_id', req.params.deviceId)
      .order('started_at', { ascending: false })
      .limit(30);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get walker stats (for anti-cheat summary)
app.get('/device/:deviceId/walker-stats', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'No database' });

    const days = parseInt(req.query.days) || 7;
    const deviceId = req.params.deviceId;

    const { data, error } = await supabase.rpc('get_walker_stats', {
      p_device_id: deviceId,
      p_days: days
    });

    if (error) {
      // Fallback if function doesn't exist
      const { data: walks } = await supabase
        .from('walk_sessions')
        .select('*')
        .eq('device_id', deviceId)
        .gte('started_at', new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString());

      const stats = {
        total_walks: walks?.length || 0,
        avg_quality_score: walks?.reduce((sum, w) => sum + (w.quality_score || 0), 0) / (walks?.length || 1),
        excellent_walks: walks?.filter(w => w.quality_score >= 90).length || 0,
        good_walks: walks?.filter(w => w.quality_score >= 70 && w.quality_score < 90).length || 0,
        fair_walks: walks?.filter(w => w.quality_score >= 50 && w.quality_score < 70).length || 0,
        poor_walks: walks?.filter(w => w.quality_score < 50).length || 0,
        total_distance_km: (walks?.reduce((sum, w) => sum + (w.distance_meters || 0), 0) / 1000).toFixed(2),
        avg_carried_percent: walks?.reduce((sum, w) => sum + (w.carried_percent || 0), 0) / (walks?.length || 1),
        vehicle_incidents: walks?.filter(w => w.vehicle_detected).length || 0
      };

      return res.json(stats);
    }

    res.json(data?.[0] || {});
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get location history
app.get('/device/:deviceId/locations', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'No database' });

    const { data, error } = await supabase
      .from('locations')
      .select('*')
      .eq('device_id', req.params.deviceId)
      .order('recorded_at', { ascending: false })
      .limit(100);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get sleep history
app.get('/device/:deviceId/sleep', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'No database' });

    const { data, error } = await supabase
      .from('sleep_sessions')
      .select('*')
      .eq('device_id', req.params.deviceId)
      .order('started_at', { ascending: false })
      .limit(30);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get scratches
app.get('/device/:deviceId/scratches', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'No database' });

    const { data, error } = await supabase
      .from('scratch_daily')
      .select('*')
      .eq('device_id', req.params.deviceId)
      .order('date', { ascending: false })
      .limit(30);

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🐕 Popcorn Gateway V6.1 (Anti-Cheat) running on port ${PORT}`);
  console.log(`   Supabase: ${supabase ? '✓ Connected' : '✗ Not configured'}`);
  console.log(`   HMAC: ${hmacKey ? '✓ Enabled' : '✗ Disabled'}`);
});
