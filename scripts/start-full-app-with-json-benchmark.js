'use strict';

// Mode terintegrasi untuk mengukur request yang melewati route SAQ Report.
// Mode ini menjalankan seluruh aplikasi dan tetap memerlukan MongoDB seperti
// konfigurasi aplikasi normal.
process.env.JSON_PARSER_BENCHMARK = '1';
require('../server.js');
