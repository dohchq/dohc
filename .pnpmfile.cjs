// drizzle-orm lists expo-sqlite as an optional peer. The services use drizzle with Postgres,
// so the phone's expo-sqlite must not join their graphs.
module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === "drizzle-orm") {
        delete pkg.peerDependencies?.["expo-sqlite"];
        delete pkg.peerDependenciesMeta?.["expo-sqlite"];
      }
      return pkg;
    },
  },
};
