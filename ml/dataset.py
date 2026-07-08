"""Loads Isle Wars per-turn training records (written by
scripts/simulate.mjs --log) into perspective-relative tensors.

Board size varies per game -- the map is procedurally generated, so a hex's
index isn't comparable across games (hex 5 might be a coastal plain in one
map and a mountain in another). Records are therefore kept as variable-length
per-hex feature sets and padded/masked per batch, rather than flattened into
a fixed-size vector indexed by hex id.

Features are also canonicalized to the acting player's perspective (mine vs.
enemy vs. neutral) rather than raw player colors, so the network learns
"is this good for whoever's turn it is" instead of memorizing color bias.
"""
import glob
import gzip
import json
import os
import random
from dataclasses import dataclass

import numpy as np
import torch
from torch.utils.data import Dataset

TERRAIN_TYPES = ["plain", "mountain", "forest", "marsh", "desert"]
TERRAIN_INDEX = {t: i for i, t in enumerate(TERRAIN_TYPES)}
TERRAIN_CLASSES = len(TERRAIN_TYPES)
PLAYERS = ["blue", "green", "red", "brown"]

HEX_FEATURE_DIM = 3 + 1 + TERRAIN_CLASSES + 1  # owner-rel(3) + armies(1) + terrain(4) + production(1)
GLOBAL_FEATURE_DIM = 5


def iter_shard_files(data_dir):
    """`data_dir` may be a single directory or a list of directories --
    letting train.py combine old and freshly-generated self-play data
    without needing the shards copied into one place."""
    dirs = [data_dir] if isinstance(data_dir, str) else data_dir
    files = []
    for d in dirs:
        files.extend(glob.glob(os.path.join(d, "*.jsonl.gz")))
    return sorted(files)


def iter_records(data_dir):
    for path in iter_shard_files(data_dir):
        with gzip.open(path, "rt") as f:
            for line in f:
                yield json.loads(line)


def iter_turn_records(data_dir):
    for rec in iter_records(data_dir):
        if rec["type"] == "turn" and rec["winner"] in PLAYERS:
            yield rec


def hex_features(rec):
    actor = rec["actor"]
    owners = rec["owners"]
    armies = rec["armies"]
    terrain = rec["terrain"]
    production = rec["production"]
    n = len(owners)
    feats = np.zeros((n, HEX_FEATURE_DIM), dtype=np.float32)
    for i in range(n):
        if owners[i] == actor:
            feats[i, 0] = 1.0
        elif owners[i] is None:
            feats[i, 2] = 1.0
        else:
            feats[i, 1] = 1.0
        feats[i, 3] = np.log1p(armies[i]) / 4.0  # squashes the long army-count tail
        feats[i, 4 + TERRAIN_INDEX[terrain[i]]] = 1.0
        feats[i, 8] = float(production[i])
    return feats


def global_features(rec):
    actor = rec["actor"]
    opponents = [p for p in PLAYERS if p != actor]
    alive = rec["alive"]
    hands = rec["hands"]
    n_alive_enemies = sum(1 for p in opponents if alive.get(p))
    my_hand = len(hands.get(actor, []))
    enemy_hand_avg = float(np.mean([len(hands.get(p, [])) for p in opponents])) if opponents else 0.0
    return np.array(
        [
            rec["turn"] / 200.0,
            len(rec["owners"]) / 60.0,
            n_alive_enemies / 3.0,
            my_hand / 5.0,
            enemy_hand_avg / 5.0,
        ],
        dtype=np.float32,
    )


def label(rec):
    return 1.0 if rec["winner"] == rec["actor"] else 0.0


@dataclass
class Example:
    hexes: np.ndarray  # (n_hexes, HEX_FEATURE_DIM)
    glob: np.ndarray  # (GLOBAL_FEATURE_DIM,)
    y: float


class IsleWarsDataset(Dataset):
    """Loads every matching shard into memory. Fine up to a few million
    records; move to a streaming/on-disk dataset if the training set
    outgrows RAM.
    """

    def __init__(self, data_dir, game_ids=None):
        self.examples = []
        for rec in iter_turn_records(data_dir):
            if game_ids is not None and rec["game_id"] not in game_ids:
                continue
            self.examples.append(Example(hex_features(rec), global_features(rec), label(rec)))

    def __len__(self):
        return len(self.examples)

    def __getitem__(self, idx):
        return self.examples[idx]

    def base_rate(self):
        if not self.examples:
            return 0.0
        return sum(ex.y for ex in self.examples) / len(self.examples)


def list_game_ids(data_dir):
    ids = set()
    for rec in iter_records(data_dir):
        if rec["type"] == "game_end":
            ids.add(rec["game_id"])
    return ids


def split_game_ids(data_dir, val_fraction=0.1, seed=0):
    """Splits by game_id, not by record -- otherwise turns from the same
    game leak across train/val and validation accuracy is meaningless
    (adjacent turns in a game are near-duplicates of each other)."""
    ids = sorted(list_game_ids(data_dir))
    rng = random.Random(seed)
    rng.shuffle(ids)
    n_val = max(1, int(len(ids) * val_fraction))
    return set(ids[n_val:]), set(ids[:n_val])


def collate(batch):
    max_n = max(ex.hexes.shape[0] for ex in batch)
    b = len(batch)
    hexes = torch.zeros((b, max_n, HEX_FEATURE_DIM), dtype=torch.float32)
    mask = torch.zeros((b, max_n), dtype=torch.float32)
    glob = torch.zeros((b, GLOBAL_FEATURE_DIM), dtype=torch.float32)
    y = torch.zeros((b,), dtype=torch.float32)
    for i, ex in enumerate(batch):
        n = ex.hexes.shape[0]
        hexes[i, :n] = torch.from_numpy(ex.hexes)
        mask[i, :n] = 1.0
        glob[i] = torch.from_numpy(ex.glob)
        y[i] = ex.y
    return hexes, mask, glob, y
