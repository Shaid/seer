declare module 'pngjs' {
  export class PNG {
    constructor(options: { width: number; height: number; filterType?: number });
    static sync: {
      write(png: PNG): Buffer;
      read(buffer: Buffer): PNG;
    };
    data: Buffer;
    width: number;
    height: number;
  }
}
