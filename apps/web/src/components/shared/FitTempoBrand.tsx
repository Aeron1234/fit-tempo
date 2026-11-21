export function FitTempoMark() {
  return <img src="/fit-tempo-mark.png" width={36} height={36} alt="" className="shrink-0" />;
}

export function FitTempoBrand() {
  return (
    <span className="tempo-wordmark inline-flex items-center gap-2 text-xl font-bold tracking-tight">
      <FitTempoMark />
      Fit Tempo
    </span>
  );
}
