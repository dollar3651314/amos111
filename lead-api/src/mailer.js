import nodemailer from 'nodemailer';

const LABELS = {
  name: 'Name',
  company: 'Company',
  email: 'Email',
  country: 'Country/Region',
  industry: 'Industry',
  volume: 'Monthly volume',
  phone: 'Phone/WhatsApp',
  message: 'Message',
  lang: 'Site language',
};

export function formatLeadEmail(lead) {
  const lines = Object.entries(LABELS)
    .filter(([k]) => lead.data[k] !== undefined)
    .map(([k, label]) => `${label}: ${lead.data[k]}`);
  return {
    subject: `[Quick Come] New demo request: ${lead.data.company}`,
    text: [
      'A new lead was submitted on the Quick Come website.',
      '',
      ...lines,
      '',
      `Lead ID: ${lead.id}`,
      `Received: ${lead.receivedAt}`,
    ].join('\n'),
  };
}

export function createSmtpSender(config) {
  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return async (lead) => {
    const { subject, text } = formatLeadEmail(lead);
    await transport.sendMail({
      from: config.mailFrom,
      to: config.mailTo,
      replyTo: lead.data.email,
      subject,
      text,
    });
  };
}
