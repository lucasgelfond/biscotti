// The package's types aren't reachable through its exports map; it has better-sqlite3's API.
declare module "better-sqlite3-multiple-ciphers" {
  import Database from "better-sqlite3";
  export default Database;
}
