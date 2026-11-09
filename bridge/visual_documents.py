"""Local, bounded page rendering, embedded-image extraction and OCR."""

import io
import math
import threading
import unicodedata
from contextlib import closing
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path


IMAGE_FORMATS = {
    '.jpg': 'JPEG', '.jpeg': 'JPEG', '.png': 'PNG', '.webp': 'WEBP',
    '.bmp': 'BMP', '.tif': 'TIFF', '.tiff': 'TIFF', '.heic': 'HEIF', '.heif': 'HEIF',
}
MAX_PDF_BYTES = 50 * 1024 * 1024
MAX_PAGES = 100
MAX_PIXELS = 40_000_000
MAX_PAGE_TEXT = 200_000
MAX_IMAGES_PER_PAGE = 24
MAX_PAGE_ASSET_BYTES = 24 * 1024 * 1024
RENDER_EDGE = 2400
PREVIEW_EDGE = 1800
PDFIUM_LOCK = threading.Lock()
DEPENDENCY_HINT = '请在工作台 Python 环境运行 python -m pip install -r requirements-ocr.txt 后重试'


class RecognitionError(ValueError):
    pass


@dataclass
class RecognizedPage:
    text: str = ''
    preview: bytes = b''
    images: list[bytes] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def visual_kind(name):
    suffix = Path(name).suffix.lower()
    if suffix == '.pdf':
        return 'PDF 文档'
    if suffix in IMAGE_FORMATS:
        return '图片'
    return None


def pdfium():
    try:
        import pypdfium2
    except (ImportError, OSError):
        raise RecognitionError(DEPENDENCY_HINT) from None
    return pypdfium2


def open_image(name, raw):
    try:
        from PIL import Image
        expected = IMAGE_FORMATS[Path(name).suffix.lower()]
        if expected == 'HEIF':
            from pillow_heif import register_heif_opener
            register_heif_opener()
    except (ImportError, OSError):
        raise RecognitionError(DEPENDENCY_HINT) from None
    try:
        return Image.open(io.BytesIO(raw), formats=[expected])
    except Image.DecompressionBombError:
        raise RecognitionError('图片像素过多，请缩小图片后重新上传') from None
    except (OSError, ValueError):
        raise RecognitionError('图片无法打开，请检查文件是否损坏或扩展名是否正确') from None


def new_report(name, raw):
    if Path(name).suffix.lower() == '.pdf':
        engine = pdfium()
        try:
            with PDFIUM_LOCK, engine.PdfDocument(raw) as pdf:
                count = len(pdf)
        except (engine.PdfiumError, OSError, ValueError):
            raise RecognitionError('无法打开 PDF，请检查文件是否损坏或已加密') from None
    else:
        try:
            with open_image(name, raw) as image:
                count = image.n_frames if image.format == 'TIFF' else 1
        except (EOFError, OSError):
            raise RecognitionError('图片页无法读取，请检查原文件') from None
    if not 1 <= count <= MAX_PAGES:
        raise RecognitionError(f'一次可识别 1–{MAX_PAGES} 页，请拆分文件后重新上传')
    return [{'page': number, 'status': 'waiting', 'text': '', 'error': ''}
            for number in range(1, count + 1)]


@lru_cache(maxsize=1)
def ocr_engine():
    try:
        from rapidocr_onnxruntime import RapidOCR
        return RapidOCR(intra_op_num_threads=2, inter_op_num_threads=1)
    except (ImportError, OSError):
        raise RecognitionError(DEPENDENCY_HINT) from None
    except Exception:
        raise RecognitionError('本机 OCR 初始化失败，请检查依赖后重试') from None


def rgb_image(image):
    from PIL import Image
    if 'A' in image.getbands() or 'transparency' in image.info:
        rgba = image.convert('RGBA')
        try:
            background = Image.new('RGB', rgba.size, 'white')
            background.paste(rgba, mask=rgba.getchannel('A'))
            return background
        finally:
            rgba.close()
    return image.convert('RGB')


def jpeg_preview(image):
    with rgb_image(image) as copy, io.BytesIO() as output:
        copy.thumbnail((PREVIEW_EDGE, PREVIEW_EDGE))
        copy.save(output, 'JPEG', quality=86)
        return output.getvalue()


def ocr_lines(image):
    try:
        with rgb_image(image) as copy, io.BytesIO() as output:
            copy.thumbnail((RENDER_EDGE, RENDER_EDGE))
            copy.save(output, 'PNG')
            lines, _ = ocr_engine()(output.getvalue())
    except RecognitionError:
        raise
    except Exception:
        raise RecognitionError('本页 OCR 失败，可以重试或手动补录文字') from None
    return [line[1].strip() for line in lines or [] if line[1].strip()]


def pixel_limit(width, height):
    if width < 1 or height < 1 or width * height > MAX_PIXELS:
        raise RecognitionError('图片像素过多，请缩小图片后重新上传')


def pdf_raster(page):
    width, height = page.get_size()
    if not (math.isfinite(width) and math.isfinite(height) and min(width, height) > 0):
        raise RecognitionError('无法读取此 PDF 页面尺寸')
    with closing(page.render(scale=min(3, RENDER_EDGE / max(width, height)))) as bitmap:
        return bitmap.to_pil().copy()


def full_page_image(page, image):
    left, bottom, right, top = page.get_bbox()
    x1, y1, x2, y2 = image.get_bounds()
    visible_width = max(0, min(right, x2) - max(left, x1))
    visible_height = max(0, min(top, y2) - max(bottom, y1))
    return visible_width * visible_height >= (right - left) * (top - bottom) * 0.85


def comparable(text):
    return ''.join(ch for ch in unicodedata.normalize('NFKC', text).casefold() if ch.isalnum())


def embedded_images(page, engine, result):
    total = 0
    for index, item in enumerate(page.get_objects(filter=[engine.raw.FPDF_PAGEOBJ_IMAGE])):
        if index >= MAX_IMAGES_PER_PAGE:
            result.errors.append('本页图片数量超过识别上限')
            break
        try:
            pixel_limit(*item.get_px_size())
            if not result.text and full_page_image(page, item):
                continue
            with closing(item.get_bitmap(render=True)) as bitmap:
                # The PIL view is closed before releasing its foreign buffer.
                bitmap.warn_on_close = False
                with bitmap.to_pil() as image, io.BytesIO() as output:
                    image.save(output, 'PNG')
                    data = output.getvalue()
            if total + len(data) > MAX_PAGE_ASSET_BYTES:
                result.errors.append('本页提取图片体积超过上限')
                break
            if data not in result.images:
                result.images.append(data)
                total += len(data)
        except (engine.PdfiumError, OSError, ValueError, RuntimeError):
            result.errors.append('本页有图片无法提取')


def read_pdf(raw, number, result, recognize):
    from PIL import Image
    engine = pdfium()
    # PDFium contexts never run in parallel. The CPU OCR work uses released
    # image copies and stays outside the lock.
    with PDFIUM_LOCK, engine.PdfDocument(raw) as pdf:
        with closing(pdf[number - 1]) as page, closing(page.get_textpage()) as textpage:
            result.text = textpage.get_text_bounded().replace('\r\n', '\n').strip()
            embedded_images(page, engine, result)
            image = pdf_raster(page)
    with image:
        result.preview = jpeg_preview(image)
        if not result.text:
            result.text = '\n'.join(recognize(image))
            return
    native = comparable(result.text)
    additions = []
    for data in result.images:
        try:
            with Image.open(io.BytesIO(data)) as image:
                for line in recognize(image):
                    key = comparable(line)
                    if key and key not in native:
                        additions.append(line)
        except RecognitionError as exc:
            result.errors.append(str(exc))
    if additions:
        result.text += '\n\n' + '\n'.join(dict.fromkeys(additions))


def read_page(name, raw, number, recognize=ocr_lines):
    result = RecognizedPage()
    try:
        if Path(name).suffix.lower() == '.pdf':
            read_pdf(raw, number, result, recognize)
        else:
            from PIL import ImageOps
            with open_image(name, raw) as image:
                image.seek(number - 1)
                pixel_limit(*image.size)
                with ImageOps.exif_transpose(image) as oriented:
                    result.preview = jpeg_preview(oriented)
                    result.text = '\n'.join(recognize(oriented))
    except RecognitionError as exc:
        result.errors.append(str(exc))
    except ImportError:
        result.errors.append(DEPENDENCY_HINT)
    except (OSError, RuntimeError, ValueError, EOFError):
        result.errors.append('无法读取本页，请重试或核对原文件')
    if len(result.text) > MAX_PAGE_TEXT:
        result.text = result.text[:MAX_PAGE_TEXT]
        result.errors.append('本页正文超过 20 万字符，请校对并保留需要的内容')
    return result
