import { Composition } from "remotion";

import { buildEdit } from "../edit";
import { Demo, type DemoProps } from "./Demo";

const placeholder = {} as DemoProps;

export function Root() {
  return (
    <Composition
      id="PairetoDemo"
      component={Demo}
      defaultProps={placeholder}
      fps={30}
      width={1920}
      height={1080}
      durationInFrames={1}
      calculateMetadata={({ props }) => {
        const edit = buildEdit(props.timeline, props.style);
        return {
          fps: props.style.fps,
          width: props.style.width,
          height: props.style.height,
          durationInFrames: Math.ceil((edit.totalMs / 1000) * props.style.fps),
        };
      }}
    />
  );
}
