'use strict';

// Jalankan SAQ Report dalam mode eksperimen: setiap request JSON dibandingkan
// dengan ze_json dan JSON.parse. Mode normal tetap memakai express.json().
process.env.JSON_PARSER_BENCHMARK = '1';
require('../server.js');
