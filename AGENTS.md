# Repository Guidelines

## 禁止手工编辑 pkg/idl 下面的源契约文件，如果你发现通讯逻辑中idl有问题，你要主动给出提示，方便人类去修改idl. idl修改只能通过 Dashboard 或 `./pr data-format` 来操作

## 注意: `pkg/idl/**/generated/**` 和 `pkg/idl/**/protocol_manifest.json` 是脚手架生成产物，只能通过 `./pr gen:interfaces`、dashboard 或对应 `tools/generate-interfaces.sh` 刷新，不要手写业务逻辑。

## module/service 下面的模块只能通过通讯协议来进行交互，严禁代码之间调用

## 执行操作建议使用pr命令（不要暴露npm命令），如果pr命令做不了，再提示用户

## 除非用户输入“我要编辑框架(慎重!!!!)”，否则只能在module目录下面修改（可以改pkg下面，但不包括idl目录）

## Module Skill Lookup

根 `AGENTS.md` 只保留固定规则，不维护具体 service 到 skill 的动态列表，避免多人创建 module 时频繁冲突。

创建或实现 `module/service/<service>` 的业务逻辑前，必须先读取 `module/service/<service>/AGENTS.md`。该文件由脚手架生成并维护当前 service 的 skill、config、IDL 和 generated 入口。

如果用户只提供 module 名称或自然语言需求，Codex/Claude 应先定位 `module/service/<service>/AGENTS.md`，再按其中引用读取 `.skill/<service>/SKILL.md`、`pkg/idl/<service>` 和 service config。

## Robot Full Stack Lookup

如果需求涉及机器人型号组合、AI Native 全栈、硬件能力、driver adapter、机器人部署 profile 或一键部署，先读取 `.skill/robot_full_stack/SKILL.md`，再读取 `pkg/robot/AGENTS.md` 和 `deploy/robot-profiles/AGENTS.md`。

机器人能力目录在 `pkg/robot/capabilities.json`，机器人 profile 在 `deploy/robot-profiles/*.json`。这些文件只能描述 capability、module 组合和部署意图，不能绕过 Dashboard 或 `./pr data-format` 手写 `pkg/idl` 源契约。
