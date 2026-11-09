"use strict";
// Original verbose strings can contain upstream bodies or identifiers. Until a
// structured diagnostic schema exists, never copy those strings to stdio.
module.exports = { enabled: () => false, verbose() {} };
