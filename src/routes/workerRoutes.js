// src/routes/workerRoutes.js
const express = require('express');
const router  = express.Router();
const { getStatus } = require('../controllers/workerController');

// GET /api/workers/status?accessKey=...&coin=LTC&workerName=004
router.get('/status', getStatus);

module.exports = router;
