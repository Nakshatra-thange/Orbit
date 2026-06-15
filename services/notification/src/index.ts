import express from 'express';
const app  = express();
const PORT = 3004;
app.use(express.json());
app.get('/health', (_req, res) =>
  res.json({ service: 'notification-service', status: 'ok', port: PORT, timestamp: new Date().toISOString() })
);
app.listen(PORT, () => console.log(`[notification-service] running on port ${PORT}`));