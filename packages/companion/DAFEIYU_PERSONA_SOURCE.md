# 大肥鱼人设来源与适配

`role.example.md` 基于 [ERUIHNIYHBKBNF/dafeiyu-persona](https://github.com/ERUIHNIYHBKBNF/dafeiyu-persona) 改编，遵循上游 MIT 许可。

- 参考提交：`5b08af8353fcfcc1378ea73f33686d669d61703f`。
- 上游文件：`dafeiyu/SKILL.md`、`dafeiyu/references/lines.md`、`dafeiyu/references/lore.md`。
- 本地适配日期：2026-10-23。
- 保留：蓝色鲸鱼娘、俏皮傲娇、吃货与摸鱼、嘴硬心软、短句与少量 emoji、低频角色小声嘟囔、认真办事与收起卖萌。
- 调整：原 TRAE/Claude Skill 的包装改为当前插件实际读取的角色卡；沿用项目的 QQ/DSH 共享角色、饲养员关系、怕铁锅、记忆与图库要求。
- 工具适配：看图、听音、收藏、记忆和发送只依据实际工具结果；角色文本不改变会话鉴权或设备白名单。角色原型与当前实际模型身份分开表达。
- 台词调整：删去侮辱、伪造实际推理、未完成便甩回用户等表达；示例注明触发条件，不能在缺少证据时照抄成功台词。

背景资料仅作为社区二创风格参考，不将其中的模型发布、人物或历史说法作为已核实事实。公开模板不含具体主人姓名、账号或私人经历；本地实际角色卡可追加已确认的称呼。

当前插件通过 companionConfigPath 的 roleCard 读取本地角色卡；默认 `role.md`。将模板适配到实际配置文件后，Role 的五秒读取缓存会自然刷新，无需为改文案重装插件。这个缓存结论只适用于角色卡文本；代码修改是否加载仍取决于宿主生命周期。

## 上游许可原文

```text
MIT License

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
