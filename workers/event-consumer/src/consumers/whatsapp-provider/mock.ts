import { WhatsAppProvider, SendTemplateMessageParams, SendMessageResult } from './interface.js';
import { logger } from '@revynta/observability';
import crypto from 'crypto';

export class MockWhatsAppProvider implements WhatsAppProvider {
  constructor(
    private phoneNumberId: string,
    private simulatedLatencyMs = 0,
    private simulatedErrorStatus?: number
  ) {}

  async sendTemplateMessage(params: SendTemplateMessageParams): Promise<SendMessageResult> {
    if (this.simulatedLatencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.simulatedLatencyMs));
    }

    if (this.simulatedErrorStatus) {
      const isRateLimit = this.simulatedErrorStatus === 429;
      const isServerErr = this.simulatedErrorStatus >= 500;
      
      const err: any = new Error(`Simulated mock WhatsApp error: Status ${this.simulatedErrorStatus}`);
      err.status = this.simulatedErrorStatus;
      err.isTransient = isRateLimit || isServerErr;
      throw err;
    }

    if (!params.templateName) {
      const err: any = new Error('Template Name is empty');
      err.status = 400;
      err.isTransient = false;
      throw err;
    }

    const providerMessageId = `wamid.MockMsgId_${crypto.randomBytes(8).toString('hex')}`;
    
    logger.info(
      { recipient: params.recipientPhoneNumber, template: params.templateName, providerMessageId },
      'Mock WhatsApp message dispatched'
    );

    return {
      providerMessageId,
      rawResponse: {
        messaging_product: 'whatsapp',
        contacts: [{ input: params.recipientPhoneNumber, wa_id: params.recipientPhoneNumber }],
        messages: [{ id: providerMessageId }],
      },
    };
  }
}
