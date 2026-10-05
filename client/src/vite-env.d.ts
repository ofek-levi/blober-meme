/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Origin of the game server, e.g. https://blober.example.com.
   * Only needed when the client is hosted apart from the server; unset (the normal
   * case) means "same origin", which covers both the Vite proxy in dev and the
   * single-process production setup.
   */
  readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
