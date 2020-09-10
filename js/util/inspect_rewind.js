var Logger, RewindBuffer, filepath, fs, i, log, next_buf, path, rewind, stream;

RewindBuffer = require("../src/streammachine/rewind_buffer");

Logger = require("../src/streammachine/logger");

path = require("path");

fs = require("fs");

filepath = process.argv[2];

if (!filepath) {
  console.error("A file path is required.");
  process.exit(1);
}

stream = null;

if (filepath === "-") {
  stream = process.stdin;
} else {
  filepath = path.resolve(filepath);
  if (!fs.existsSync(filepath)) {
    console.error("File not found.");
    process.exit(1);
  }
  stream = fs.createReadStream(filepath);
}

log = new Logger({
  stdout: true
});

rewind = new RewindBuffer({
  seconds: 999999,
  burst: 30,
  key: "inspector",
  log: log
});

rewind.once("header", function(header) {
  return console.log("Rewind Buffer Header: ", header);
});

next_buf = null;

i = 0;

rewind.on("buffer", function(chunk) {
  var expected_ts;
  if (next_buf) {
    expected_ts = Number(chunk.ts) + chunk.duration;
    if ((Number(next_buf.ts) - 50 > expected_ts) || (expected_ts > Number(next_buf.ts) + 50)) {
      console.log("Gap? " + i + "\nGot: " + next_buf.ts + "\n  Expected: " + (new Date(expected_ts)) + "\n  Offset: " + (Number(expected_ts - next_buf.ts)));
    }
  }
  next_buf = chunk;
  return i += 1;
});

rewind.loadBuffer(stream, (function(_this) {
  return function(err, stats) {
    return console.log("loadBuffer complete: ", stats);
  };
})(this));

//# sourceMappingURL=inspect_rewind.js.map
