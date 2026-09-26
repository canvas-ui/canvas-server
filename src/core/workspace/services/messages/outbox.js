import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

async function syncDirectory(root) {
    const directory = await fs.open(root, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
}

export function messageError(message, statusCode = 400) {
    return Object.assign(new Error(message), { statusCode });
}

export async function readSendReceipt(root, requestId, principal) {
    if (!/^[\w-]{16,128}$/.test(requestId || '')) throw messageError('Invalid requestId');
    const key = crypto.createHash('sha256').update(requestId).digest('hex');
    let stored;
    try { stored = JSON.parse(await fs.readFile(path.join(root, `${key}.json`), 'utf8')); }
    catch (error) {
        if (error.code === 'ENOENT') throw messageError('Send request not found', 404);
        throw messageError('Send status is not yet available', 409);
    }
    if (stored.actor !== principal) throw messageError('Send request not found', 404);
    return stored.result || { status: 'unknown', requestId, message: 'Send is in progress or delivery is unconfirmed. Do not start a new send.' };
}

// A durable send fence, not an automatic retry queue. SMTP cannot promise
// exactly-once delivery after a timeout. Never repeat an ambiguous attempt.
export async function sendOnce(root, requestId, input, deliver) {
    if (!/^[\w-]{16,128}$/.test(requestId || '')) throw messageError('A stable requestId (16–128 letters, digits, _ or -) is required');
    const key = crypto.createHash('sha256').update(requestId).digest('hex');
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const target = path.join(root, `${key}.json`);
    let handle;
    try { handle = await fs.open(target, 'wx', 0o600); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let previous;
        try { previous = JSON.parse(await fs.readFile(target, 'utf8')); }
        catch { throw messageError('This send is in progress or its result is unknown. Do not resend with another requestId.', 409); }
        if (previous.fingerprint !== fingerprint) throw messageError('requestId was already used for different content', 409);
        return previous.result || { status: 'unknown', requestId, message: 'Delivery may have occurred. Check the conversation before starting a new send.' };
    }
    try {
        await handle.writeFile(JSON.stringify({ fingerprint, actor: input.principal, startedAt: new Date().toISOString() }));
        await handle.sync();
    } finally { await handle.close(); }
    await syncDirectory(root);
    let result;
    try { result = { ...await deliver(), requestId }; }
    catch {
        result = { status: 'unknown', requestId, message: 'Delivery could not be confirmed. Check the conversation before starting a new send.' };
    }
    const temp = `${target}.${crypto.randomUUID()}.tmp`;
    const receipt = await fs.open(temp, 'wx', 0o600);
    try { await receipt.writeFile(JSON.stringify({ fingerprint, actor: input.principal, result })); await receipt.sync(); }
    finally { await receipt.close(); }
    await fs.rename(temp, target);
    await syncDirectory(root);
    return result;
}
