const express = require('express');
const router  = express.Router();
const { getStatus } = require('../controllers/statusController');

// GET /status/:workerName/:coin/:watcherCode
router.get('/:workerName/:coin/:watcherCode', getStatus);

module.exports = router;
