# iLink protocol fixtures

此目录保存根据腾讯官方Backend API Protocol构造的合成fixture。所有ID、cursor、
context token和登录token均为不可用placeholder；禁止保存真实token、cookie、二维码或
消息内容。

`getupdates-input.json`用于无副作用文本闭环；其余fixture覆盖文本状态查询、附件拒绝、
认证过期、发送成功和扫码状态。`getupdates-real-shape.json`来自真实响应的脱敏结构，
覆盖缺省`ret`、超出JavaScript safe integer的消息ID和空私聊`session_id`。
`known-errors.json`固化已验证的HTTP分类、token过期错误码以及未知错误码的兼容性信号；
未知码不得被误判为认证或普通网络故障。
