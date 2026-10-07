declare module "jpeg-js" {
  interface DecodedJpeg {
    data: Uint8Array;
    width: number;
    height: number;
  }

  interface DecodeOptions {
    useTArray?: boolean;
    maxResolutionInMP?: number;
    maxMemoryUsageInMB?: number;
  }

  const jpeg: {
    decode(data: Uint8Array, options?: DecodeOptions): DecodedJpeg;
  };

  export default jpeg;
}
