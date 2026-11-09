// Fake upstream tokens. Tests check that none of these ever reach a response
// or a log. (Deliberately unlike real token formats, so secret scanners don't
// mistake them for leaked credentials.)
module.exports = {
  googleAccess: "fake-google-access-token-DO-NOT-LEAK",
  googleRefresh: "fake-google-refresh-token-DO-NOT-LEAK",
  spotifyAccess: "fake-spotify-access-token-DO-NOT-LEAK",
  spotifyRefresh: "fake-spotify-refresh-token-DO-NOT-LEAK",
};
