"""User-facing stage labels; percentages apply to a measured stage only."""
STAGE_LABELS = {
    'queued': 'Waiting for the processing worker',
    'model_loading': 'Preparing model weights (download or cache)',
    'extracting_audio': 'Extracting audio from the selected section',
    'analyzing': 'Analyzing speaker activity',
    'segmentation': 'Detecting speech and speaker changes',
    'speaker_counting': 'Estimating simultaneous speakers',
    'embeddings': 'Extracting voice features',
    'clustering': 'Grouping turns by voice',
    'discrete_diarization': 'Assembling the speaker timeline',
    'identity_embeddings': 'Comparing clean voice regions',
    'matching': 'Assigning speaker labels to the timeline',
    'references': 'Building reference voice profiles',
    'provenance': 'Recording input and model provenance',
    'saving': 'Saving the timeline and exports',
    'complete': 'Analysis complete',
    'failed': 'Processing failed',
}
STAGE_UNITS = {'segmentation': 'chunks', 'embeddings': 'batches',
               'identity_embeddings': 'voices', 'references': 'clips'}
