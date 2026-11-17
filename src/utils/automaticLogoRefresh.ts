// SPDX-License-Identifier: GPL-3.0-or-later
import {type ArtworkPayload} from './normalizeArtworkPayload';
import {artworkMime} from './imageMetadata';
import {loadSafeImage,releaseImage,releaseCanvas,canvasToBase64,throwIfImageCancelled,MAX_ARTWORK_DIMENSION,MAX_ARTWORK_PIXELS,withCompositionLock} from './imageSafety';

/** A fresh logo is saved first. These new pixels make Steam reload that logo. */
export async function resizeAutomaticLogoOnePixel(payload:ArtworkPayload,signal:AbortSignal):Promise<ArtworkPayload>{
 return withCompositionLock(async()=>{
  throwIfImageCancelled(signal);if(payload.animated||!payload.data||!payload.dimensions)throw Error('PA_ERROR_INVALID_ARTWORK');
  const [width,height]=payload.dimensions;
  const direction=width+1<=MAX_ARTWORK_DIMENSION&&height+1<=MAX_ARTWORK_DIMENSION&&(width+1)*(height+1)<=MAX_ARTWORK_PIXELS?1:-1;
  const nextWidth=width+direction,nextHeight=height+direction;
  if(!Number.isInteger(width)||!Number.isInteger(height)||nextWidth<1||nextHeight<1||nextWidth>MAX_ARTWORK_DIMENSION||nextHeight>MAX_ARTWORK_DIMENSION||nextWidth*nextHeight>MAX_ARTWORK_PIXELS)throw Error('PA_ERROR_INVALID_ARTWORK');
  const image=await loadSafeImage(`data:${artworkMime(payload.format)};base64,${payload.data}`,signal),canvas=document.createElement('canvas');
  try{
   if(image.naturalWidth!==width||image.naturalHeight!==height)throw Error('PA_ERROR_INVALID_ARTWORK');
   canvas.width=nextWidth;canvas.height=nextHeight;const context=canvas.getContext('2d');if(!context)throw Error('PA_ERROR_INVALID_ARTWORK');
   context.drawImage(image,0,0,nextWidth,nextHeight);throwIfImageCancelled(signal);
   const data=await canvasToBase64(canvas,'png');throwIfImageCancelled(signal);
   return{data,format:'png',animated:false,dimensions:[nextWidth,nextHeight]};
  }finally{releaseImage(image);releaseCanvas(canvas);}
 });
}
