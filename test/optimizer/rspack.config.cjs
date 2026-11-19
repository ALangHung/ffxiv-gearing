// 將自動配裝比對、隨機驗證與回報重播腳本打包成 Node 可直接執行的檔案（原始碼使用 require 載入資料與 TypeScript，無法直接以 Node 執行）
const path = require('path');

module.exports = {
  mode: 'development',
  target: 'node',
  devtool: false,
  entry: {
    compare: path.resolve(__dirname, 'compare.ts'),
    fuzz: path.resolve(__dirname, 'fuzz.ts'),
    replay: path.resolve(__dirname, 'replay.ts'),
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].cjs',
    library: { type: 'commonjs2' },
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        loader: 'builtin:swc-loader',
        options: { jsc: { parser: { syntax: 'typescript' } } },
      },
    ],
  },
  node: {
    __filename: false,  // 保留執行時的實際路徑，子程序需要用它重新執行此檔案
  },
  stats: 'errors-warnings',
};
