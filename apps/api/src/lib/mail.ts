import type { AppConfig } from "../config.js";

interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

interface EmailTemplateMessage {
  to: string;
  subject: string;
  template: string;
  variables: Record<string, unknown>;
}

/**
 * Provider de email abstrato para convites e reset de senha.
 * No V1 local ele apenas escreve no log para nao amarrar o produto a um provedor.
 */
export class EmailService {
  private readonly config: AppConfig;

  public constructor(config: AppConfig) {
    this.config = config;
  }

  public async send(message: EmailMessage): Promise<void> {
    console.info(
      JSON.stringify({
        from: this.config.SMTP_FROM,
        kind: "email.preview",
        html: message.html,
        subject: message.subject,
        to: message.to
      })
    );
  }

  /**
   * Renderiza um template basico em HTML e registra o preview localmente.
   */
  public async sendTemplate(message: EmailTemplateMessage): Promise<void> {
    const html = `
      <html>
        <body style="font-family: Arial, sans-serif">
          <h2>${message.subject}</h2>
          <p>Template: ${message.template}</p>
          <pre>${JSON.stringify(message.variables, null, 2)}</pre>
        </body>
      </html>
    `;

    await this.send({
      html,
      subject: message.subject,
      to: message.to
    });
  }
}
