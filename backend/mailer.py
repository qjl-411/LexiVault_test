"""Send account codes through the backend's configured TLS SMTP connection."""
import os
import smtplib
import ssl
from dataclasses import dataclass
from email.message import EmailMessage


@dataclass(frozen=True, repr=False)
class EmailSender:
    host: str
    port: int
    username: str
    password: str
    sender: str
    security: str

    @classmethod
    def from_env(cls):
        host = os.getenv('LEXIVAULT_SMTP_HOST', '').strip()
        username = os.getenv('LEXIVAULT_SMTP_USER', '').strip()
        password = os.getenv('LEXIVAULT_SMTP_PASSWORD', '')
        sender = os.getenv('LEXIVAULT_SMTP_FROM', username).strip()
        security = os.getenv('LEXIVAULT_SMTP_SECURITY', 'ssl').strip().lower()
        try:
            port = int(os.getenv('LEXIVAULT_SMTP_PORT', '587' if security == 'starttls' else '465'))
        except ValueError:
            return None
        if not all((host,username,password,sender)) or security not in {'ssl','starttls'} or not 1 <= port <= 65535:
            return None
        return cls(host,port,username,password,sender,security)

    def _send(self, recipient, subject, body):
        message = EmailMessage()
        message['From'] = self.sender
        message['To'] = recipient
        message['Subject'] = f'LexiVault · {subject}'
        message.set_content(body)
        context = ssl.create_default_context()
        if self.security == 'ssl':
            connection = smtplib.SMTP_SSL(self.host,self.port,timeout=8,context=context)
        else:
            connection = smtplib.SMTP(self.host,self.port,timeout=8)
        with connection as smtp:
            if self.security == 'starttls':
                smtp.starttls(context=context)
            smtp.login(self.username,self.password)
            smtp.send_message(message)

    def send_code(self, email, purpose, code):
        action = {'register':'注册账号','verify_email':'验证邮箱','reset_password':'重置密码'}[purpose]
        self._send(email, f'{action}验证码',
                   f'你的{action}验证码为 {code}，10 分钟内有效。请在 LexiVault 页面输入验证码。\n'
                   '如果这不是你的操作，可以忽略此邮件。请勿将验证码告知他人。')

    def notify_password_reset(self, email):
        self._send(email, '密码已重置', '你的 LexiVault 密码已重置，旧登录会话已失效。')
