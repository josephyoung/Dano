export interface TokenizerAssetSource {
  repository: string;
  revision: string;
  'tokenizer.json': string;
  'tokenizer_config.json': string;
}
export function installMemoryTokenizers(directory: string, catalog: readonly TokenizerAssetSource[],
  download?: (url: string) => Promise<Buffer>): Promise<void>;
