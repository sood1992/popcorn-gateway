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

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Popcorn GPS Collar Gateway',
    version: '6.0.0',
    supabase: supabase ? 'configured' : 'missing',
    hmac: hmacKey ? 'configured' : 'disabled'
  });
});

app.post('/telemetry', async (req, res) => {
  try {
    const data = req.body;
    if (!data || !data.device_id) {
      return res.status(400).json({ error: 'Missing device_id' });
    }
    if (!supabase) {
      return res.status(500).json({ error: 'Database not configured' });
    }

    await supabase.from('device_status').upsert({
      device_id: data.device_id,
      latitude: data.latitude,
      longitude: data.longitude,
      battery_percent: data.battery_percent,
      activity_name: data.activity_name,
      is_home: data.is_home,
      last_seen_at: new Date().toISOString()
    }, { onConflict: 'device_id' });

    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/device/:deviceId/status', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'No database' });
  const { data } = await supabase.from('device_status').select('*').eq('device_id', req.params.deviceId).single();
  res.json(data || {});
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Gateway running on port ${PORT}`);
});
