/**
 * 生成一份示例笔记，直观展示「每个 PDF 一份专属 Markdown」的最终形态。
 * 用法：node scripts/gen-example.js
 */
const path = require('path');
const { Notes } = require('../electron/lib/notes');

const T0 = '2026-08-28T18:35:22';
const T1 = '2026-08-28T19:02:47';
const T2 = '2026-08-28T19:40:10';

const meta = {
  hash: 'a1b2c3d4e5f60718',
  filePath: 'D:\\papers\\attention-is-all-you-need.pdf',
  fileName: 'attention-is-all-you-need.pdf',
  title: 'Attention Is All You Need',
  pageCount: 15,
  createdAt: T0,
  updatedAt: T2
};

const conversations = [
  {
    id: 'c-l8k2m3',
    createdAt: T0,
    updatedAt: T0,
    mode: 'context',
    model: 'deepseek-chat',
    annotated: true,
    annotNo: 1,
    conclusion:
      'Q/K/V 均由同一份输入嵌入经三个参数独立的线性变换得到，每头维度 d_model/n_head；拼接头后再做一次输出投影。缩放因子 sqrt(d_k) 用于防止点积方差爆炸。',
    anchor: {
      page: 3,
      lineStart: 12,
      lineEnd: 14,
      quote: 'The attention function can be described as mapping a query and a set of key-value pairs to an output.'
    },
    messages: [
      {
        role: 'user',
        content: '这里的 Q、K、V 具体是怎么得到的？同一份输入为什么要做三次不同的变换？',
        at: T0
      },
      {
        role: 'assistant',
        model: 'deepseek-chat',
        usage: { prompt_tokens: 2140, completion_tokens: 486 },
        at: T0,
        content:
          '## 结论\n\n' +
          'Q、K、V 都由**同一份输入**经过三次**参数独立**的线性变换得到【第 3 页 第 12 行】。\n\n' +
          '### 具体过程\n\n' +
          '设输入序列的嵌入矩阵为 $X \\in \\mathbb{R}^{n \\times d_{model}}$，则：\n\n' +
          '1. $Q = X W^Q$，$K = X W^K$，$V = X W^V$\n' +
          '2. 三个权重矩阵形状均为 $d_{model} \\times d_k$，各自独立学习\n' +
          '3. 多头注意力下，每个头的维度是 $d_k = d_{model} / h$\n\n' +
          '### 为什么要三次变换\n\n' +
          '- 让同一个词在不同"角色"下被检索：**作为查询**时强调"我在找什么"，**作为键**时强调"我可被什么匹配到"，**作为值**时携带"匹配上之后要交出什么内容"\n' +
          '- 若三者共用一套参数，注意力会退化为对自身的相似度打分，表达能力大幅受限【第 4 页 第 3 行】\n\n' +
          '公式里的缩放因子 $\\sqrt{d_k}$ 是为了避免点积方差随 $d_k$ 增大而爆炸，导致 softmax 进入饱和区。'
      }
    ]
  },
  {
    id: 'c-p9x4n1',
    createdAt: T1,
    updatedAt: T1,
    mode: 'web',
    model: 'deepseek-chat',
    annotated: false,
    conclusion: '',
    anchor: { page: 8, lineStart: 5, lineEnd: 5, quote: 'Table 2: Ablation study on the Transformer architecture.' },
    messages: [
      {
        role: 'user',
        content: '论文表格里的 Big 模型配置，和后来 FlashAttention 那类工作相比，显存瓶颈主要在哪？',
        at: T1
      },
      {
        role: 'assistant',
        model: 'deepseek-chat',
        usage: { prompt_tokens: 3820, completion_tokens: 512 },
        at: T1,
        sources: [
          {
            title: 'Attention Is All You Need (arXiv:1706.03762)',
            url: 'https://arxiv.org/abs/1706.03762',
            snippet: 'The Transformer is the first transduction model relying entirely on self-attention...',
            date: '2017-06-12'
          },
          {
            title: 'FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness',
            url: 'https://arxiv.org/abs/2205.14135',
            snippet: 'We propose FlashAttention, an IO-aware exact attention algorithm...',
            date: '2022-05-27'
          }
        ],
        content:
          '原始 Transformer 的显存瓶颈在注意力矩阵本身：序列长度为 n 时需要 $O(n^2)$ 的空间存 attention scores [1][2]。\n\n' +
          '- Big 配置（$d_{model}=1024$，$h=16$）训练时用到约 8 张 P100 [1]\n' +
          '- FlashAttention 通过**分块计算 + 重计算**把显存压到 $O(n)$，代价是多了约 20%~30% 的计算量 [2]\n' +
          '- 注意：这些是推理与训练阶段的工程优化，**不改变**模型结构本身，论文里的结论依然成立【第 8 页 第 5 行】'
      }
    ]
  },
  {
    id: 'c-m2r7k9',
    createdAt: T2,
    updatedAt: T2,
    mode: 'image',
    model: 'glm-4v-flash',
    annotated: true,
    annotNo: 2,
    conclusion: '',
    anchor: { page: 11, lineStart: null, lineEnd: null, quote: '(扫描区域，无文本层)' },
    messages: [
      {
        role: 'user',
        content: '这张图里的两条曲线分别代表什么？为什么 base 在训练后期反而更稳？',
        at: T2
      },
      {
        role: 'assistant',
        model: 'glm-4v-flash',
        usage: { prompt_tokens: 1560, completion_tokens: 288 },
        at: T2,
        content:
          '图中是论文 Figure 2 的模型结构示意（左）与训练曲线（右）【第 11 页】：\n\n' +
          '- **左侧**：编码器（下）与解码器（上）的多头注意力连接关系\n' +
          '- **右侧**：纵轴是 BLEU，横轴是训练步数；实线为 big 模型，虚线为 base 模型\n\n' +
          'base 曲线后期更平缓，通常是因为小模型更快接近其容量上限，学习率衰减后收益递减；big 模型仍在持续爬升。'
      }
    ]
  }
];

function main() {
  const outDir = path.join(__dirname, '..', 'examples');
  const notes = new Notes(outDir);
  const p = notes.write(meta, conversations);
  console.log(`示例笔记已生成：${p}`);
}

main();
