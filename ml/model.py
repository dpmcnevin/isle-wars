"""DeepSets-style value network. Board size varies per game (procedural
maps), so hexes are encoded independently by a shared per-hex MLP and then
mean-pooled into a fixed-size board embedding, instead of being flattened
into a vector indexed by hex id -- that pooling is what makes the model
well-defined across differently-sized/shaped maps.
"""
import torch
import torch.nn as nn

from dataset import GLOBAL_FEATURE_DIM, HEX_FEATURE_DIM


class ValueNet(nn.Module):
    def __init__(self, hex_hidden=32, head_hidden=64):
        super().__init__()
        self.hex_encoder = nn.Sequential(
            nn.Linear(HEX_FEATURE_DIM, hex_hidden),
            nn.ReLU(),
            nn.Linear(hex_hidden, hex_hidden),
            nn.ReLU(),
        )
        self.head = nn.Sequential(
            nn.Linear(hex_hidden + GLOBAL_FEATURE_DIM, head_hidden),
            nn.ReLU(),
            nn.Linear(head_hidden, 1),
        )

    def forward(self, hexes, mask, glob):
        # hexes: (B, N, HEX_FEATURE_DIM), mask: (B, N), glob: (B, GLOBAL_FEATURE_DIM)
        encoded = self.hex_encoder(hexes)  # (B, N, hidden)
        masked = encoded * mask.unsqueeze(-1)
        pooled = masked.sum(dim=1) / mask.sum(dim=1, keepdim=True).clamp(min=1.0)
        x = torch.cat([pooled, glob], dim=-1)
        return self.head(x).squeeze(-1)  # logits, BCEWithLogitsLoss applies the sigmoid
