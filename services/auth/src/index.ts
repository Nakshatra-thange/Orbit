import express from 'express';
const app  = express();
const PORT = 3001;

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({
    service:   'auth-service',
    status:    'ok',
    port:      PORT,
    timestamp: new Date().toISOString(),
  });
});

app.get('/auth/me', (_req, res) => {
  res.json({ service: 'auth', endpoint: 'me', stub: true });
});

app.listen(PORT, () =>
  console.log(`[auth-service] running on port ${PORT}`)
);