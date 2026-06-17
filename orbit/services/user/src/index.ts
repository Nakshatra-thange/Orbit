import express from 'express';
const app  = express();
const PORT = 3002;
app.use(express.json());
app.get('/health', (_req, res) =>
  res.json({ service: 'user-service', status: 'ok', port: PORT, timestamp: new Date().toISOString() })
);
app.get('/users/me', (_req, res) =>
  res.json({ service: 'user', endpoint: 'me', stub: true })
);
app.listen(PORT, () => console.log(`[user-service] running on port ${PORT}`));