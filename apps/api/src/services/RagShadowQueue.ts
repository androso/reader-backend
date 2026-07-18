import {
    createRagRerankShadowQueue,
    enqueueRagRerankShadowJob,
    type RagRerankShadowJobData,
    type RagRerankShadowQueue,
} from "@reader/jobs";

let queue: RagRerankShadowQueue | null = null;

const getQueue = () => {
    if (!queue) queue = createRagRerankShadowQueue();
    return queue;
};

export const enqueueRagRerankShadow = async (
    payload: RagRerankShadowJobData
) => enqueueRagRerankShadowJob(getQueue(), payload);

export const closeRagRerankShadowQueue = async () => {
    if (!queue) return;
    await queue.close();
    queue = null;
};
