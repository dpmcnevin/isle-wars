"""Train the Isle Wars value network on simulated self-play data.

    python train.py --data ../training-data --epochs 10

Predicts P(the acting player wins) from the board state at the start of
their turn. In a 4-player free-for-all the base rate is ~25%, so accuracy
alone is a weak signal -- always predicting "I lose" scores ~75% accuracy
while learning nothing. Compare val_loss against the printed baseline_loss
(the loss a constant base-rate predictor would get) instead: only a val_loss
meaningfully below that means the model found real signal in the board.
"""
import argparse
import math
import os
import time

import torch
from torch.utils.data import DataLoader

from dataset import IsleWarsDataset, collate, split_game_ids
from model import ValueNet


def binary_entropy(p):
    if p <= 0.0 or p >= 1.0:
        return 0.0
    return -(p * math.log(p) + (1 - p) * math.log(1 - p))


def evaluate(model, loader, device):
    model.eval()
    total_loss = 0.0
    correct = 0
    n = 0
    loss_fn = torch.nn.BCEWithLogitsLoss(reduction="sum")
    with torch.no_grad():
        for hexes, mask, glob, y in loader:
            hexes, mask, glob, y = hexes.to(device), mask.to(device), glob.to(device), y.to(device)
            logits = model(hexes, mask, glob)
            total_loss += loss_fn(logits, y).item()
            correct += ((logits > 0) == (y > 0.5)).sum().item()
            n += y.shape[0]
    return total_loss / n, correct / n


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default="../training-data", help="comma-separated list of data directories")
    parser.add_argument("--epochs", type=int, default=10)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--val-fraction", type=float, default=0.1)
    parser.add_argument("--out", default="checkpoints/value_net.pt")
    args = parser.parse_args()

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"device: {device}")

    data_dirs = [d.strip() for d in args.data.split(",") if d.strip()]
    print(f"data: {data_dirs}")

    print("splitting games into train/val...")
    train_ids, val_ids = split_game_ids(data_dirs, args.val_fraction)
    print(f"{len(train_ids)} train games, {len(val_ids)} val games")

    print("loading train set...")
    train_ds = IsleWarsDataset(data_dirs, game_ids=train_ids)
    print("loading val set...")
    val_ds = IsleWarsDataset(data_dirs, game_ids=val_ids)
    print(f"{len(train_ds)} train records, {len(val_ds)} val records")

    base_rate = train_ds.base_rate()
    baseline_loss = binary_entropy(base_rate)
    print(f"base rate (actor wins): {base_rate:.3f}  baseline_loss: {baseline_loss:.4f}  <- beat this, not 'accuracy'")

    train_loader = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True, collate_fn=collate)
    val_loader = DataLoader(val_ds, batch_size=args.batch_size, shuffle=False, collate_fn=collate)

    model = ValueNet().to(device)
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    loss_fn = torch.nn.BCEWithLogitsLoss()

    os.makedirs(os.path.dirname(args.out), exist_ok=True)

    for epoch in range(1, args.epochs + 1):
        model.train()
        t0 = time.time()
        total_loss = 0.0
        for hexes, mask, glob, y in train_loader:
            hexes, mask, glob, y = hexes.to(device), mask.to(device), glob.to(device), y.to(device)
            opt.zero_grad()
            logits = model(hexes, mask, glob)
            loss = loss_fn(logits, y)
            loss.backward()
            opt.step()
            total_loss += loss.item() * y.shape[0]
        train_loss = total_loss / len(train_ds)
        val_loss, val_acc = evaluate(model, val_loader, device)
        print(
            f"epoch {epoch:3d}  train_loss {train_loss:.4f}  val_loss {val_loss:.4f}"
            f"  val_acc {val_acc:.3f}  ({time.time() - t0:.1f}s)"
        )
        torch.save(model.state_dict(), args.out)

    print(f"saved -> {args.out}")


if __name__ == "__main__":
    main()
