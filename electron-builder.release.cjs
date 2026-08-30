const packageMetadata = require("./package.json");

module.exports = {
  ...packageMetadata.build,
  forceCodeSigning: true,
  mac: {
    ...packageMetadata.build.mac,
    notarize: true
  },
  win: {
    ...packageMetadata.build.win,
    signAndEditExecutable: true
  }
};
