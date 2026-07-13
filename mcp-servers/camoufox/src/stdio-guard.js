// A stdio MCP server owns stdout exclusively: every byte must be a JSON-RPC
// frame, or a strict client closes the connection. Dependencies do print —
// camoufox-js logs addon and GeoIP skip notices with console.log during
// browser launch — so all console output is forced onto stderr. The MCP SDK
// transport writes frames through process.stdout directly and is unaffected.
const toStderr = console.error.bind(console);
console.log = toStderr;
console.info = toStderr;
console.warn = toStderr;
console.debug = toStderr;
