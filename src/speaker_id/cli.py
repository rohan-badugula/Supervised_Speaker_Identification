from __future__ import annotations

import argparse
import sys
from dataclasses import asdict
from pathlib import Path

from .backends import DEFAULT_MODEL, MODEL_SPECS, get_model, load_backend
from .pipeline import enroll_speakers, identify_speakers, resolve_token
from .profiles import load_profiles, save_profiles
from .provenance import package_versions, sha256_file
from .reporting import write_csv_report, write_json_report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="voice-id",
        description="Supervised speaker diarization for recorded audio and video.",
    )
    parser.add_argument("--token", help="Hugging Face token; prefer the HF_TOKEN environment variable.")
    parser.add_argument("--device", default="cpu", help="PyTorch device, such as cpu or cuda.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("models", help="List supported model configurations without loading weights.")

    enroll = subparsers.add_parser("enroll", help="Build named voice profiles from reference clips.")
    enroll.add_argument("enrollment_dir", type=Path)
    enroll.add_argument("--profiles", type=Path, default=Path("artifacts/voiceprints.npz"))
    enroll.add_argument("--model", default=DEFAULT_MODEL)

    identify = subparsers.add_parser("identify", help="Diarize a recording and assign enrolled names.")
    identify.add_argument("source", type=Path)
    identify.add_argument("--profiles", type=Path, default=Path("artifacts/voiceprints.npz"))
    identify.add_argument("--output", type=Path, default=Path("results/identified.json"))
    identify.add_argument("--threshold", type=float, default=0.55)
    identify.add_argument("--margin", type=float, default=0.08)
    identify.add_argument("--min-speakers", type=int)
    identify.add_argument("--max-speakers", type=int)
    identify.add_argument("--model", help="Defaults to the model recorded in the profile bundle.")

    return parser


def run(args: argparse.Namespace) -> int:
    if args.command == "models":
        for spec in MODEL_SPECS:
            print(f"{spec.key}: {spec.description}")
        return 0
    if args.command == "enroll":
        spec = get_model(args.model)
        backend = load_backend(spec.key, token=resolve_token(args.token), device=args.device)
        bundle = enroll_speakers(backend, args.enrollment_dir)
        save_profiles(bundle, args.profiles)
        print(f"Saved {len(bundle.embeddings)} speaker profiles to {args.profiles}")
        for name, count in sorted(bundle.clip_counts.items()):
            print(f"  {name}: {count} enrollment clip(s)")
        return 0

    bundle = load_profiles(args.profiles)
    spec = get_model(args.model or bundle.model_id)
    if spec.model_id != bundle.model_id:
        raise ValueError("Selected model does not match these profiles. Re-enroll with --model first.")
    input_hash = sha256_file(args.source)
    profile_hash = sha256_file(args.profiles)
    backend = load_backend(spec.key, token=resolve_token(args.token), device=args.device)
    report = identify_speakers(
        backend,
        args.source,
        bundle,
        threshold=args.threshold,
        minimum_margin=args.margin,
        min_speakers=args.min_speakers,
        max_speakers=args.max_speakers,
    )
    report["run"]["model_key"] = spec.key
    report["run"]["device"] = args.device
    report["run"]["model_config"] = asdict(spec)
    report["run"]["source_sha256"] = input_hash
    report["run"]["profiles_sha256"] = profile_hash
    report["run"]["package_versions"] = package_versions()
    write_json_report(report, args.output)
    csv_path = args.output.with_suffix(".csv")
    write_csv_report(report["segments"], csv_path)
    print(f"Wrote {args.output} and {csv_path}")
    for name, seconds in report["summary_seconds"].items():
        print(f"  {name}: {seconds:.1f}s")
    return 0


def main() -> None:
    parser = build_parser()
    try:
        raise SystemExit(run(parser.parse_args()))
    except (FileNotFoundError, RuntimeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(2) from error


if __name__ == "__main__":
    main()
