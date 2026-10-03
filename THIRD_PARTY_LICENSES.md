# 第三方许可证

网页的本地 MP3 转谱使用 Spotify AB 的 `@spotify/basic-pitch` 1.0.1 及其 TensorFlow.js 运行库。相关代码和模型采用 Apache License 2.0；原始许可证随 npm 包提供。

未修改安装包或模型；本项目的 `audio-worker.js` 依据 Basic Pitch 1.0.1 `inference.ts` 的窗口尺寸、重叠裁剪和输出名称实现逐窗推理及张量回收，音符后处理复用原库。参考：<https://github.com/spotify/basic-pitch-ts>。

TensorFlow.js 3.21.0 及 WASM 后端版权归 Google LLC 等贡献者，采用 Apache-2.0；打包器保留依赖中的许可证注释，构建同时输出依赖许可汇总 `licenses.txt` 与模型的 `model/LICENSE`。网页只在用户浏览器本地处理音频，不上传歌曲。
