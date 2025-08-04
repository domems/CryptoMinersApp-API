const express = require('express');
const router  = express.Router();
const { getStatus } = require('../controllers/workerController');

// GET /status/:workerName/:coin/:watcherCode
router.get('/:workerName/:coin/:watcherCode', getStatus);

module.exports = router;
