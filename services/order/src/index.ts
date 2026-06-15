import express from 'express';
const app  = express();
const PORT = 3003;
app.use(express.json());
app.get('/health', (_req, res) =>
  res.json({ service: 'order-service', status: 'ok', port: PORT, timestamp: new Date().toISOString() })
);
app.get('/orders', (_req, res) =>
  res.json({ service: 'order', endpoint: 'orders', stub: true })
);
app.listen(PORT, () => console.log(`[order-service] running on port ${PORT}`));