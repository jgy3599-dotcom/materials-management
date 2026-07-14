import io
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.application import MIMEApplication
import streamlit as st


# 구매가 필요한 자재 목록을 엑셀 파일로 첨부해서 네이버 메일로 보내는 함수입니다.
# secrets.toml의 [naver_mail]에 적어둔 계정으로 로그인해서, 같은 계정 앞으로 메일을 보냅니다.
def send_purchase_alert_email(need_purchase_df):
    sender = st.secrets["naver_mail"]["sender_email"]
    password = st.secrets["naver_mail"]["app_password"]

    # 표를 엑셀 파일로 만들되, 디스크에 저장하지 않고 메모리(BytesIO)에서 바로 만듭니다.
    excel_buffer = io.BytesIO()
    need_purchase_df.to_excel(excel_buffer, index=False, engine="openpyxl")
    excel_buffer.seek(0)

    msg = MIMEMultipart()
    msg["Subject"] = f"[자재관리] 구매 필요 알림 ({len(need_purchase_df)}건)"
    msg["From"] = sender
    msg["To"] = sender
    msg.attach(MIMEText(f"구매가 필요한 자재 {len(need_purchase_df)}건을 첨부 엑셀 파일로 보내드립니다."))

    attachment = MIMEApplication(excel_buffer.read(), _subtype="xlsx")
    # 첨부파일 이름에 한글을 쓰면 메일 프로그램에 따라 깨질 수 있어 영문 파일명을 사용합니다.
    attachment.add_header("Content-Disposition", "attachment", filename="purchase_needed_list.xlsx")
    msg.attach(attachment)

    # 465번 포트 + SSL은 네이버 메일이 요구하는 SMTP 접속 방식입니다.
    with smtplib.SMTP_SSL("smtp.naver.com", 465) as server:
        server.login(sender, password)
        server.sendmail(sender, [sender], msg.as_string())
