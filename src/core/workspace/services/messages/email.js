import nodemailer from 'nodemailer';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import crypto from 'node:crypto';
import { messageError } from './outbox.js';

export function emailAddresses(value) {
    const entries = Array.isArray(value) ? value : (value ? [value] : []);
    return [...new Set(entries.flatMap((entry) => {
        if (typeof entry === 'object' && entry?.address) return [entry.address];
        return addressparser(String(entry || '')).flatMap((p) => p.group || [p]).map((p) => p.address);
    }).filter(Boolean).map((s) => String(s).trim()))];
}

export function normalizeSmtp(input = {}, previous = {}) {
    const smtp = { ...previous, ...input };
    if (input.password === '' || input.password === true) smtp.password = previous.password;
    const out = {
        enabled: smtp.enabled === true, allowAgentSend: smtp.allowAgentSend === true,
        host: String(smtp.host || '').trim(), port: Number(smtp.port || 587),
        secure: smtp.secure === true, user: String(smtp.user || '').trim(),
        password: typeof smtp.password === 'string' ? smtp.password : '',
        from: String(smtp.from || '').trim(), sentFolder: String(smtp.sentFolder || 'Sent').trim(),
        appendSent: smtp.appendSent === true,
    };
    if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) throw messageError('Invalid SMTP port');
    if (out.enabled && (!out.host || emailAddresses(out.from).length !== 1 || !/^[^\s@]+@[^\s@]+$/.test(emailAddresses(out.from)[0] || ''))) throw messageError('SMTP host and one From address are required');
    if (/[\r\n]/.test(out.from)) throw messageError('Invalid From address');
    return out;
}

export function emailRecipients(from, input = {}, parent = null) {
    const own = emailAddresses(from)[0] || '';
    const data = parent?.data || {};
    const fromSelf = emailAddresses(data.from).some((s) => s.toLowerCase() === own.toLowerCase());
    let to = emailAddresses(input.to);
    if (!to.length && parent) to = emailAddresses(fromSelf ? data.to : (data.replyTo || data.headers?.['reply-to'] || data.from));
    let cc = emailAddresses(input.cc);
    if (input.replyAll && parent) {
        to = [...new Set([...to, ...emailAddresses(data.to)])];
        cc = [...new Set([...cc, ...emailAddresses(data.cc)])];
    }
    if (parent) {
        to = to.filter((s) => s.toLowerCase() !== own.toLowerCase());
        cc = cc.filter((s) => s.toLowerCase() !== own.toLowerCase());
    }
    cc = cc.filter((s) => !to.some((t) => t.toLowerCase() === s.toLowerCase()));
    const bcc = emailAddresses(input.bcc);
    return { to, cc, bcc };
}

export async function prepareEmail(config, input, parent = null) {
    const smtp = config.smtp;
    if (!smtp?.enabled || config.readOnly) throw messageError('Sending is not enabled for this email account', 403);
    const own = emailAddresses(smtp.from)[0];
    const data = parent?.data || {};
    const { to, cc, bcc } = emailRecipients(smtp.from, input, parent);
    const recipients = [...to, ...cc, ...bcc];
    if (!recipients.length || recipients.some((s) => /[\r\n]/.test(s) || !/^[^\s@]+@[^\s@]+$/.test(s))) throw messageError('Valid email recipients are required');
    if (recipients.length > 100) throw messageError('Too many recipients');
    const subject = input.subject ?? (parent ? (/^re:/i.test(data.subject || '') ? data.subject : `Re: ${data.subject || ''}`) : '');
    if (/[\r\n]/.test(subject)) throw messageError('Invalid subject');
    const parentId = data.messageId;
    const references = [...new Set([...String(Array.isArray(data.references) ? data.references.join(' ') : data.references || '').matchAll(/<[^<>\r\n]+>/g)].map((m) => m[0]).concat(parentId ? [parentId] : []))];
    const messageId = `<${crypto.randomUUID()}@${own.split('@')[1]}>`;
    const mail = {
        from: smtp.from, to, cc, subject, text: input.text, messageId,
        ...(parentId ? { inReplyTo: parentId, references } : {}),
        disableFileAccess: true, disableUrlAccess: true,
    };
    const built = await nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' }).sendMail(mail);
    return { raw: built.message, envelope: { from: own, to: recipients }, messageId, to, cc, subject };
}

export async function deliverEmail(config, prepared) {
    const smtp = config.smtp;
    const transport = nodemailer.createTransport({
        host: smtp.host, port: smtp.port, secure: smtp.secure,
        requireTLS: !smtp.secure,
        ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.password } } : {}),
        connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
        disableFileAccess: true, disableUrlAccess: true,
    });
    try {
        const info = await transport.sendMail({ raw: prepared.raw, envelope: prepared.envelope });
        return { status: 'accepted', providerMessageId: prepared.messageId, accepted: info.accepted || [], rejected: info.rejected || [] };
    } finally { transport.close(); }
}
