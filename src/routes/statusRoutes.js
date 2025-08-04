// src/routes/statusRoutes.js
import express from 'express';
import { getStatus } from '../controllers/statusController.js';

const router = express.Router();

// GET /api/status/:workerName/:coin/:watcherCode
router.get('/:workerName/:coin/:watcherCode', getStatus);

export default router;  // <-- aqui a exportação default
