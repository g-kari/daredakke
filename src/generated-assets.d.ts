declare module '*.generated.json' {
  const assets: Record<string, { body: string; contentType: string }>;
  export default assets;
}
