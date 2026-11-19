// 將魔晶石最佳化的結果比對與隨機驗證腳本打包成 Node 可直接執行的檔案（原始碼使用 require 載入資料與 TypeScript，無法直接以 Node 執行）
const path = require('path');

module.exports = {
  mode: 'development',
  target: 'node',
  devtool: false,
  entry: {
    compare: path.resolve(__dirname, 'compare.ts'),
    fuzz: path.resolve(__dirname, 'fuzz.ts'),
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
    __dirname: false,  // 保留執行時的實際路徑，用來找到 results.json
    __filename: false,
  },
  stats: 'errors-warnings',
};
